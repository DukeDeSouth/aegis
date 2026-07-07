/**
 * Discord Bot API client (F10): Gateway v10 + REST send. Injectable for tests.
 */
export interface DiscordGatewayEvent {
  readonly op: number;
  readonly t?: string;
  readonly s?: number;
  readonly d?: unknown;
}

export interface DiscordClient {
  runGateway(
    onMessage: (msg: import('./policy.ts').DiscordMessage) => void,
    onSequence: (seq: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  sendMessage(channelId: string, text: string): Promise<void>;
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

export class LiveDiscordClient implements DiscordClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly wsFactory: (url: string) => WebSocket;

  constructor(
    tokenRef: string,
    opts: { fetchFn?: typeof fetch; wsFactory?: (url: string) => WebSocket } = {},
  ) {
    const token = process.env[tokenRef];
    if (!token) throw new Error(`discord bot token env not set (ref: ${tokenRef})`);
    this.token = token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    const res = await this.fetchFn(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      throw new DiscordApiError(`discord send failed: ${res.status}`, res.status >= 500 || res.status === 429);
    }
  }

  async runGateway(
    onMessage: (msg: import('./policy.ts').DiscordMessage) => void,
    onSequence: (seq: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const gw = await this.fetchFn('https://discord.com/api/v10/gateway/bot', {
      headers: { Authorization: `Bot ${this.token}` },
    });
    if (!gw.ok) throw new DiscordApiError(`gateway bot failed: ${gw.status}`);
    const { url } = (await gw.json()) as { url: string };
    const ws = this.wsFactory(`${url}/?v=10&encoding=json`);
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
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
        const pkt = JSON.parse(String(ev.data)) as DiscordGatewayEvent;
        if (pkt.s !== undefined) onSequence(pkt.s);
        if (pkt.op === 10) {
          const interval = (pkt.d as { heartbeat_interval: number }).heartbeat_interval;
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: `Bot ${this.token}`,
                intents: (1 << 12) | (1 << 15),
                properties: { os: 'linux', browser: 'aegis', device: 'aegis' },
              },
            }),
          );
          heartbeatInterval = setInterval(() => ws.send(JSON.stringify({ op: 1, d: pkt.s })), interval);
        }
        if (pkt.t === 'MESSAGE_CREATE' && pkt.d) {
          onMessage(pkt.d as import('./policy.ts').DiscordMessage);
        }
      });
      ws.addEventListener('error', () => done(new DiscordApiError('websocket error', true)));
      ws.addEventListener('close', () => done(signal.aborted ? undefined : new DiscordApiError('websocket closed', true)));
    });
  }
}
