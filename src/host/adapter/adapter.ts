/**
 * Channel Adapter для Telegram (Sprint 2): мост между Bot API и очередями ядра.
 * Тонкий транспорт без бизнес-логики; единственные решения — авторизация
 * (deny-by-default + одноразовый pairing) и провенанс, оба фиксируются в audit.
 * receiver: getUpdates → classify → publish('inbound', provenance='owner') | deny.
 * sender:   claim('outbound') → sendMessage → ack | retry (visibility timeout) | dead.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AuditLog } from '../audit/log.ts';
import type { QueueStore } from '../queue/store.ts';
import { parseOutboundPayload } from '../orchestrator/message.ts';
import { classifyUpdate, extractUntrustedBody } from './policy.ts';
import type { ChannelState } from './state.ts';
import { TelegramError, type TelegramClient, type TgUpdate } from './telegram-client.ts';

export interface TelegramAdapterOptions {
  worker?: string;
  pollMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const ACTOR = 'adapter';
const SESSION_PREFIX = 'tg:';

function quarantineSource(reason: 'forwarded' | 'non_text'): 'forwarded' | 'attachment' {
  return reason === 'forwarded' ? 'forwarded' : 'attachment';
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** 'tg:123' → 123; undefined — сессия не принадлежит этому каналу. */
export function chatIdFromSession(sessionId: string): number | undefined {
  if (!sessionId.startsWith(SESSION_PREFIX)) return undefined;
  const n = Number(sessionId.slice(SESSION_PREFIX.length));
  return Number.isSafeInteger(n) ? n : undefined;
}

export class TelegramAdapter {
  private readonly client: TelegramClient;
  private readonly queues: QueueStore;
  private readonly audit: AuditLog;
  private readonly state: ChannelState;
  private readonly pairingCode: string;
  private readonly worker: string;
  private readonly pollMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private pollHealthy = true;

  constructor(
    client: TelegramClient,
    queues: QueueStore,
    audit: AuditLog,
    state: ChannelState,
    pairingCodeRef: string,
    opts: TelegramAdapterOptions = {},
  ) {
    const code = process.env[pairingCodeRef];
    if (!code) {
      throw new Error(`pairing code env var is not set (ref: ${pairingCodeRef})`);
    }
    this.client = client;
    this.queues = queues;
    this.audit = audit;
    this.state = state;
    this.pairingCode = code;
    this.worker = opts.worker ?? 'adapter-1';
    this.pollMs = opts.pollMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all([this.runReceiver(signal), this.runSender(signal)]);
  }

  /** Long polling getUpdates; 409 Conflict гасит только receiver (fail-closed, ядро живёт). */
  async runReceiver(signal: AbortSignal): Promise<void> {
    let backoffMs = 1000;
    while (!signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await this.client.getUpdates(this.state.getOffset(), signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramError && err.conflict) {
          this.audit.append({
            actor: ACTOR,
            action: 'channel.conflict',
            decision: 'deny',
            payload: { detail: 'another getUpdates poller is running; receiver stopped' },
          });
          console.error('telegram receiver stopped: 409 conflict (another poller?)');
          return;
        }
        // Audit только при смене состояния (SIMULATION): лежащая сеть не заливает журнал.
        if (this.pollHealthy) {
          this.pollHealthy = false;
          this.audit.append({
            actor: ACTOR,
            action: 'channel.poll_failed',
            decision: 'info',
            payload: { error: err instanceof Error ? err.message : String(err) },
          });
        }
        const wait =
          err instanceof TelegramError && err.retryAfterMs !== undefined
            ? err.retryAfterMs
            : backoffMs;
        await this.sleep(wait, signal);
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        continue;
      }

      backoffMs = 1000;
      if (!this.pollHealthy) {
        this.pollHealthy = true;
        this.audit.append({ actor: ACTOR, action: 'channel.poll_recovered', decision: 'info' });
      }

      let maxId: number | undefined;
      for (const update of updates) {
        await this.handleUpdate(update);
        maxId = update.update_id;
      }
      // Offset после обработки батча: at-least-once, дубль при краше приемлем (IMPACT R4).
      if (maxId !== undefined) this.state.setOffset(maxId + 1);
      if (updates.length === 0) await this.sleep(this.pollMs, signal);
    }
  }

  /** Доставка ответов: transient-ошибка возвращает сообщение через visibility timeout. */
  async runSender(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const had = await this.processOutbound();
      if (!had) await this.sleep(this.pollMs, signal);
    }
  }

  /** Обрабатывает одно outbound-сообщение; false — очередь пуста. */
  async processOutbound(): Promise<boolean> {
    const msg = this.queues.claim('outbound', this.worker);
    if (!msg) return false;

    if (msg.attempts > msg.max_attempts) {
      this.queues.markDead(msg.id);
      this.audit.append({
        actor: ACTOR,
        action: 'message.send_dead',
        decision: 'deny',
        payload: { messageId: msg.id, attempts: msg.attempts },
      });
      return true;
    }

    const payload = parseOutboundPayload(msg.payload);
    const chatId = payload ? chatIdFromSession(payload.session_id) : undefined;
    if (!payload || chatId === undefined) {
      // Не tg-сессия или битый payload: единственный канал MVP — помечаем dead (см. SIMULATION).
      this.queues.markDead(msg.id);
      this.audit.append({
        actor: ACTOR,
        action: 'message.send_malformed',
        decision: 'deny',
        payload: { messageId: msg.id },
      });
      return true;
    }

    try {
      await this.client.sendMessage(chatId, payload.text);
      this.queues.ack(msg.id);
      this.audit.append({
        actor: ACTOR,
        action: 'message.sent',
        decision: 'info',
        payload: { messageId: msg.id, sessionId: payload.session_id },
      });
    } catch (err) {
      const transient = err instanceof TelegramError && err.transient;
      if (!transient) this.queues.markDead(msg.id);
      this.audit.append({
        actor: ACTOR,
        action: transient ? 'message.send_retry' : 'message.send_failed',
        decision: transient ? 'info' : 'deny',
        payload: {
          messageId: msg.id,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return true;
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const c = classifyUpdate(update, this.state.getOwnerUserId());
    switch (c.kind) {
      case 'owner_text':
        this.queues.publish(
          'inbound',
          JSON.stringify({ text: c.text, session_id: `${SESSION_PREFIX}${c.chatId}` }),
          'owner',
        );
        this.audit.append({
          actor: ACTOR,
          action: 'message.accepted',
          decision: 'info',
          payload: { updateId: update.update_id, provenance: 'owner' },
        });
        break;
      case 'approve_attempt':
        this.queues.publish(
          'inbound',
          JSON.stringify({
            kind: 'approved_action',
            token: c.token,
            session_id: `${SESSION_PREFIX}${c.chatId}`,
          }),
          'owner',
        );
        this.audit.append({
          actor: ACTOR,
          action: 'approval.submitted',
          decision: 'info',
          payload: { updateId: update.update_id },
        });
        break;
      case 'pair_attempt':
        await this.handlePair(c.chatId, c.fromId, c.code, update.update_id);
        break;
      case 'untrusted': {
        const msg = update.message;
        if (!msg) break;
        const body = extractUntrustedBody(msg);
        const source = quarantineSource(c.reason);
        this.queues.publish(
          'inbound',
          JSON.stringify({
            kind: 'quarantine_content',
            source,
            body,
            session_id: `${SESSION_PREFIX}${c.chatId}`,
          }),
          'quarantine',
        );
        this.audit.append({
          actor: ACTOR,
          action: 'message.quarantine_enqueued',
          decision: 'info',
          payload: { updateId: update.update_id, source, reason: c.reason },
        });
        break;
      }
      case 'stranger':
        // Тихий deny: ответ был бы оракулом существования бота.
        this.audit.append({
          actor: ACTOR,
          action: 'message.denied_stranger',
          decision: 'deny',
          payload: { updateId: update.update_id },
        });
        break;
      case 'ignored':
        break;
    }
  }

  private async handlePair(
    chatId: number,
    fromId: number,
    code: string,
    updateId: number,
  ): Promise<void> {
    if (this.state.getOwnerUserId() !== undefined) {
      this.audit.append({
        actor: ACTOR,
        action: 'pairing.denied',
        decision: 'deny',
        payload: { updateId, detail: 'already paired' },
      });
      return;
    }
    const expected = Buffer.from(this.pairingCode, 'utf8');
    const actual = Buffer.from(code, 'utf8');
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) {
      // Сам код (ни верный, ни присланный) в audit не попадает.
      this.audit.append({
        actor: ACTOR,
        action: 'pairing.failed',
        decision: 'deny',
        payload: { updateId },
      });
      return;
    }
    this.state.setOwnerUserId(fromId);
    this.audit.append({
      actor: ACTOR,
      action: 'channel.paired',
      decision: 'info',
      payload: { updateId, ownerUserId: fromId },
    });
    await this.trySend(chatId, 'Paired. This bot now answers only to you.');
  }

  /** Сервисный ответ: сбой отправки не роняет receiver и не блокирует обработку батча. */
  private async trySend(chatId: number, text: string): Promise<void> {
    try {
      await this.client.sendMessage(chatId, text);
    } catch (err) {
      this.audit.append({
        actor: ACTOR,
        action: 'channel.notify_failed',
        decision: 'info',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
