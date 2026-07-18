/**
 * Slack Socket Mode client (Sprint 31): apps.connections.open + chat.postMessage.
 */
import type { SlackMessage } from './policy.ts';

export interface SlackClient {
  runSocketMode(onMessage: (msg: SlackMessage) => void, signal: AbortSignal): Promise<void>;
  sendMessage(channelId: string, text: string): Promise<void>;
}

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

interface SocketEnvelope {
  readonly envelope_id?: string;
  readonly type?: string;
  readonly payload?: {
    readonly event?: {
      readonly type?: string;
      readonly channel?: string;
      readonly user?: string;
      readonly text?: string;
      readonly channel_type?: string;
      readonly bot_id?: string;
      readonly subtype?: string;
    };
  };
}

function parseSlackEvent(body: SocketEnvelope): SlackMessage | undefined {
  const ev = body.payload?.event;
  if (ev?.type !== 'message') return undefined;
  if (typeof ev.channel !== 'string' || typeof ev.user !== 'string') return undefined;
  const text = ev.text ?? '';
  return {
    channel: ev.channel,
    user: ev.user,
    text,
    ...(ev.channel_type !== undefined ? { channel_type: ev.channel_type } : {}),
    ...(ev.bot_id !== undefined ? { bot_id: ev.bot_id } : {}),
    ...(ev.subtype !== undefined ? { subtype: ev.subtype } : {}),
  };
}

export class LiveSlackClient implements SlackClient {
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly wsFactory: (url: string) => WebSocket;

  constructor(
    botTokenRef: string,
    appTokenRef: string,
    opts: { fetchFn?: typeof fetch; wsFactory?: (url: string) => WebSocket } = {},
  ) {
    const bot = process.env[botTokenRef];
    const app = process.env[appTokenRef];
    if (!bot) throw new Error(`slack bot token env not set (ref: ${botTokenRef})`);
    if (!app) throw new Error(`slack app token env not set (ref: ${appTokenRef})`);
    this.botToken = bot;
    this.appToken = app;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    const res = await this.fetchFn('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: channelId, text }),
    });
    if (!res.ok) {
      throw new SlackApiError(`slack send failed: ${res.status}`, res.status >= 500 || res.status === 429);
    }
    const data = (await res.json()) as { ok?: boolean };
    if (!data.ok) throw new SlackApiError('slack send not ok', false);
  }

  async runSocketMode(onMessage: (msg: SlackMessage) => void, signal: AbortSignal): Promise<void> {
    const open = await this.fetchFn('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.appToken}` },
    });
    if (!open.ok) throw new SlackApiError(`slack connections.open failed: ${open.status}`, true);
    const { url, ok } = (await open.json()) as { url?: string; ok?: boolean };
    if (!ok || !url) throw new SlackApiError('slack connections.open not ok', true);

    const ws = this.wsFactory(url);
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve();
      };
      signal.addEventListener('abort', () => done(), { once: true });

      ws.addEventListener('message', (ev) => {
        const env = JSON.parse(String(ev.data)) as SocketEnvelope;
        if (env.type === 'events_api' && env.envelope_id) {
          ws.send(JSON.stringify({ envelope_id: env.envelope_id, payload: {} }));
          const msg = parseSlackEvent(env);
          if (msg) onMessage(msg);
        }
      });
      ws.addEventListener('error', () => done(new SlackApiError('websocket error', true)));
      ws.addEventListener('close', () =>
        done(signal.aborted ? undefined : new SlackApiError('websocket closed', true)),
      );
    });
  }
}

/** @internal test helper */
export function parseSlackSocketEventForTest(body: unknown): SlackMessage | undefined {
  return parseSlackEvent(body as SocketEnvelope);
}
