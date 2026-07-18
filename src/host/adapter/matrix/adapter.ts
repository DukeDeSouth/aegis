/**
 * Matrix channel adapter (Sprint 30): DM-only, pairing, outbound matrix: sessions.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AuditLog } from '../../audit/log.ts';
import type { QueueStore } from '../../queue/store.ts';
import { parseOutboundPayload } from '../../orchestrator/message.ts';
import type { ChannelState } from '../state.ts';
import { MATRIX_SESSION_PREFIX, sessionSuffix, type ChannelAdapter } from '../channel.ts';
import { classifyMatrixMessage, type MatrixMessage } from './policy.ts';
import { MatrixApiError, type MatrixClient } from './client.ts';

const ACTOR = 'matrix-adapter';

export interface MatrixAdapterOptions {
  worker?: string;
  pollMs?: number;
  syncTimeoutMs?: number;
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

export class MatrixAdapter implements ChannelAdapter {
  private readonly client: MatrixClient;
  private readonly queues: QueueStore;
  private readonly audit: AuditLog;
  private readonly state: ChannelState;
  private readonly pairingCode: string;
  private readonly worker: string;
  private readonly pollMs: number;
  private readonly syncTimeoutMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    client: MatrixClient,
    queues: QueueStore,
    audit: AuditLog,
    state: ChannelState,
    pairingCodeRef: string,
    opts: MatrixAdapterOptions = {},
  ) {
    const code = process.env[pairingCodeRef];
    if (!code) throw new Error(`pairing code env not set (ref: ${pairingCodeRef})`);
    this.client = client;
    this.queues = queues;
    this.audit = audit;
    this.state = state;
    this.pairingCode = code;
    this.worker = opts.worker ?? 'matrix-adapter-1';
    this.pollMs = opts.pollMs ?? 500;
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all([this.runSyncLoop(signal), this.runSender(signal)]);
  }

  private async runSyncLoop(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const since = this.state.getMatrixSyncToken();
        const result = await this.client.sync(since, this.syncTimeoutMs, signal);
        if (result.nextBatch.length > 0) {
          this.state.setMatrixSyncToken(result.nextBatch);
        }
        for (const msg of result.messages) {
          this.handleMessage(msg);
        }
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
      if (this.state.getMatrixOwnerUserId() === undefined) {
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
    const roomId = payload ? sessionSuffix(payload.session_id, MATRIX_SESSION_PREFIX) : undefined;
    if (!payload) {
      this.queues.markDead(msg.id);
      return true;
    }
    if (roomId === undefined) {
      this.queues.release(msg.id);
      return true;
    }
    try {
      await this.client.sendMessage(roomId, payload.text);
      this.queues.ack(msg.id);
    } catch (err) {
      const transient = err instanceof MatrixApiError && err.transient;
      if (!transient) this.queues.markDead(msg.id);
    }
    return true;
  }

  private handleMessage(msg: MatrixMessage): void {
    const c = classifyMatrixMessage(msg, this.state.getMatrixOwnerUserId());
    const session = `${MATRIX_SESSION_PREFIX}${msg.roomId}`;
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
        void this.handlePair(c.roomId, c.sender, c.code);
        break;
      case 'stranger':
        this.audit.append({
          actor: ACTOR,
          action: 'message.denied_stranger',
          decision: 'deny',
          payload: { sender: msg.sender },
        });
        break;
      default:
        break;
    }
  }

  private async handlePair(roomId: string, sender: string, code: string): Promise<void> {
    if (this.state.getMatrixOwnerUserId() !== undefined) return;
    const ok =
      Buffer.from(this.pairingCode).length === Buffer.from(code).length &&
      timingSafeEqual(Buffer.from(this.pairingCode), Buffer.from(code));
    if (!ok) {
      this.audit.append({ actor: ACTOR, action: 'pairing.failed', decision: 'deny', payload: {} });
      return;
    }
    this.state.setMatrixOwnerUserId(sender);
    this.audit.append({
      actor: ACTOR,
      action: 'channel.paired',
      decision: 'info',
      payload: { ownerUserId: sender, channel: 'matrix' },
    });
    try {
      await this.client.sendMessage(roomId, 'Paired. This bot now answers only to you in DM.');
    } catch {
      /* non-fatal */
    }
  }
}
