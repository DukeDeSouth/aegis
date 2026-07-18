/**
 * WebChat channel adapter (Sprint 29): localhost HTTP, pairing, outbound long-poll.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AuditLog } from '../../audit/log.ts';
import type { QueueStore } from '../../queue/store.ts';
import { parseOutboundPayload } from '../../orchestrator/message.ts';
import {
  WEBCHAT_DEFAULT_SESSION,
  WEBCHAT_SESSION_PREFIX,
  sessionSuffix,
  type ChannelAdapter,
} from '../channel.ts';
import type { ChannelState } from '../state.ts';
import { WebchatOutbox } from './outbox.ts';
import { startWebchatServer } from './server.ts';
import type { SkillSummary } from '../../../skills/types.ts';
import type { WebchatHistoryMessage } from './history.ts';

const DEFAULT_STATIC = join(
  fileURLToPath(new URL('../../../../packages/aegis-webchat/public', import.meta.url)),
);

export interface WebChatAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly staticRoot?: string;
  readonly pollMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly listSkills?: () => SkillSummary[];
  readonly getHistory?: (limit: number) => WebchatHistoryMessage[];
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

export class WebChatAdapter implements ChannelAdapter {
  private readonly queues: QueueStore;
  private readonly audit: AuditLog;
  private readonly state: ChannelState;
  private readonly pairingCode: string;
  private readonly host: string;
  private readonly port: number;
  private readonly staticRoot: string;
  private readonly worker: string;
  private readonly pollMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly listSkills?: () => SkillSummary[];
  private readonly getHistory?: (limit: number) => WebchatHistoryMessage[];
  private readonly outbox = new WebchatOutbox();
  private server: Server | undefined;

  constructor(
    queues: QueueStore,
    audit: AuditLog,
    state: ChannelState,
    pairingCodeRef: string,
    opts: WebChatAdapterOptions = {},
  ) {
    const code = process.env[pairingCodeRef];
    if (!code) throw new Error(`pairing code env not set (ref: ${pairingCodeRef})`);
    this.queues = queues;
    this.audit = audit;
    this.state = state;
    this.pairingCode = code;
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 8790;
    this.staticRoot = opts.staticRoot ?? DEFAULT_STATIC;
    this.worker = 'webchat-adapter-1';
    this.pollMs = opts.pollMs ?? 200;
    this.sleep = opts.sleep ?? defaultSleep;
    this.listSkills = opts.listSkills;
    this.getHistory = opts.getHistory;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.server = await startWebchatServer({
      host: this.host,
      port: this.port,
      pairingCode: this.pairingCode,
      staticRoot: this.staticRoot,
      queues: this.queues,
      audit: this.audit,
      state: this.state,
      outbox: this.outbox,
      listSkills: this.listSkills,
      getHistory: this.getHistory,
    });
    signal.addEventListener(
      'abort',
      () => {
        this.server?.close();
      },
      { once: true },
    );
    await this.runSender(signal);
  }

  private async runSender(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const had = await this.processOutbound();
      if (!had) await this.sleep(this.pollMs, signal);
    }
  }

  async processOutbound(): Promise<boolean> {
    const msg = this.queues.claim('outbound', this.worker);
    if (!msg) return false;
    const payload = parseOutboundPayload(msg.payload);
    const suffix = payload ? sessionSuffix(payload.session_id, WEBCHAT_SESSION_PREFIX) : undefined;
    if (!payload) {
      this.queues.markDead(msg.id);
      return true;
    }
    if (suffix === undefined) {
      this.queues.release(msg.id);
      return true;
    }
    const sessionId = payload.session_id || WEBCHAT_DEFAULT_SESSION;
    this.outbox.push(sessionId, payload.text);
    this.queues.ack(msg.id);
    return true;
  }
}
