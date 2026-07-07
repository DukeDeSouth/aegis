/**
 * Email input channel (F10): poll → quarantine_content only (no owner provenance).
 */
import type { AuditLog } from '../../audit/log.ts';
import type { QueueStore } from '../../queue/store.ts';
import type { ChannelState } from '../state.ts';
import { EMAIL_SESSION_PREFIX, type ChannelAdapter } from '../channel.ts';
import type { EmailFetcher, EmailMessage } from './fetcher.ts';

const ACTOR = 'email-adapter';

export interface EmailInputAdapterOptions {
  sessionId?: string;
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function formatEmailBody(m: EmailMessage): string {
  return `From: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`;
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

export class EmailInputAdapter implements ChannelAdapter {
  private readonly fetcher: EmailFetcher;
  private readonly queues: QueueStore;
  private readonly audit: AuditLog;
  private readonly state: ChannelState;
  private readonly sessionId: string;
  private readonly pollMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    fetcher: EmailFetcher,
    queues: QueueStore,
    audit: AuditLog,
    state: ChannelState,
    opts: EmailInputAdapterOptions = {},
  ) {
    this.fetcher = fetcher;
    this.queues = queues;
    this.audit = audit;
    this.state = state;
    this.sessionId = opts.sessionId ?? `${EMAIL_SESSION_PREFIX}inbox`;
    this.pollMs = opts.pollMs ?? 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const last = this.state.getEmailLastUid() ?? 0;
      const batch = await this.fetcher.fetchSince(last);
      for (const mail of batch) {
        this.queues.publish(
          'inbound',
          JSON.stringify({
            kind: 'quarantine_content',
            source: 'email',
            body: formatEmailBody(mail),
            session_id: this.sessionId,
          }),
          'quarantine',
        );
        this.state.setEmailLastUid(mail.uid);
        this.audit.append({
          actor: ACTOR,
          action: 'email.quarantine_enqueued',
          decision: 'info',
          payload: { uid: mail.uid, from: mail.from },
        });
      }
      await this.sleep(this.pollMs, signal);
    }
  }
}
