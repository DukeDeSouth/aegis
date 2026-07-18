/**
 * Slack channel adapter (Sprint 31): Socket Mode DM-only, pairing, outbound slack: sessions.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AuditLog } from '../../audit/log.ts';
import type { QueueStore } from '../../queue/store.ts';
import { parseOutboundPayload } from '../../orchestrator/message.ts';
import type { ChannelState } from '../state.ts';
import { SLACK_SESSION_PREFIX, sessionSuffix, type ChannelAdapter } from '../channel.ts';
import { classifySlackMessage, type SlackMessage } from './policy.ts';
import { SlackApiError, type SlackClient } from './client.ts';

const ACTOR = 'slack-adapter';

export interface SlackAdapterOptions {
  worker?: string;
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

export class SlackAdapter implements ChannelAdapter {
  private readonly client: SlackClient;
  private readonly queues: QueueStore;
  private readonly audit: AuditLog;
  private readonly state: ChannelState;
  private readonly pairingCode: string;
  private readonly worker: string;
  private readonly pollMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    client: SlackClient,
    queues: QueueStore,
    audit: AuditLog,
    state: ChannelState,
    pairingCodeRef: string,
    opts: SlackAdapterOptions = {},
  ) {
    const code = process.env[pairingCodeRef];
    if (!code) throw new Error(`pairing code env not set (ref: ${pairingCodeRef})`);
    this.client = client;
    this.queues = queues;
    this.audit = audit;
    this.state = state;
    this.pairingCode = code;
    this.worker = opts.worker ?? 'slack-adapter-1';
    this.pollMs = opts.pollMs ?? 500;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all([this.runReceiver(signal), this.runSender(signal)]);
  }

  private async runReceiver(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        await this.client.runSocketMode((msg) => this.handleMessage(msg), signal);
        backoff = 1000;
      } catch (err) {
        if (signal.aborted) return;
        this.audit.append({
          actor: ACTOR,
          action: 'channel.poll_failed',
          decision: 'info',
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
        await this.sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async runSender(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.state.getSlackOwnerUserId() === undefined) {
        await this.sleep(this.pollMs, signal);
        continue;
      }
      const had = await this.processOutbound();
      if (!had) await this.sleep(this.pollMs, signal);
    }
  }

  async processOutbound(): Promise<boolean> {
    const msg = this.queues.claim('outbound', this.worker);
    if (!msg) return false;
    const payload = parseOutboundPayload(msg.payload);
    const channelId = payload ? sessionSuffix(payload.session_id, SLACK_SESSION_PREFIX) : undefined;
    if (!payload) {
      this.queues.markDead(msg.id);
      return true;
    }
    if (channelId === undefined) {
      this.queues.release(msg.id);
      return true;
    }
    try {
      await this.client.sendMessage(channelId, payload.text);
      this.queues.ack(msg.id);
    } catch (err) {
      const transient = err instanceof SlackApiError && err.transient;
      if (!transient) this.queues.markDead(msg.id);
    }
    return true;
  }

  private handleMessage(msg: SlackMessage): void {
    const c = classifySlackMessage(msg, this.state.getSlackOwnerUserId());
    const session = `${SLACK_SESSION_PREFIX}${msg.channel}`;
    switch (c.kind) {
      case 'owner_text':
        this.queues.publish('inbound', JSON.stringify({ text: c.text, session_id: session }), 'owner');
        break;
      case 'approve_attempt':
        this.queues.publish(
          'inbound',
          JSON.stringify({
            kind: 'approved_action',
            token: c.token,
            session_id: session,
            ...(c.totpCode ? { totp_code: c.totpCode } : {}),
          }),
          'owner',
        );
        break;
      case 'pair_attempt':
        void this.handlePair(c.channelId, c.userId, c.code);
        break;
      case 'stranger':
        this.audit.append({
          actor: ACTOR,
          action: 'message.denied_stranger',
          decision: 'deny',
          payload: { userId: msg.user },
        });
        break;
      default:
        break;
    }
  }

  private async handlePair(channelId: string, userId: string, code: string): Promise<void> {
    if (this.state.getSlackOwnerUserId() !== undefined) return;
    const ok =
      Buffer.from(this.pairingCode).length === Buffer.from(code).length &&
      timingSafeEqual(Buffer.from(this.pairingCode), Buffer.from(code));
    if (!ok) {
      this.audit.append({ actor: ACTOR, action: 'pairing.failed', decision: 'deny', payload: {} });
      return;
    }
    this.state.setSlackOwnerUserId(userId);
    this.audit.append({
      actor: ACTOR,
      action: 'channel.paired',
      decision: 'info',
      payload: { ownerUserId: userId, channel: 'slack' },
    });
    try {
      await this.client.sendMessage(channelId, 'Paired. This bot now answers only to you in DM.');
    } catch {
      /* non-fatal */
    }
  }
}
