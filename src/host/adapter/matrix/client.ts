/**
 * Matrix Client-Server API client (Sprint 30): /sync long-poll + send. Injectable for tests.
 */
import { randomBytes } from 'node:crypto';
import type { MatrixMessage } from './policy.ts';

export interface MatrixSyncResult {
  readonly nextBatch: string;
  readonly messages: readonly MatrixMessage[];
}

export interface MatrixClient {
  sync(since: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<MatrixSyncResult>;
  sendMessage(roomId: string, text: string): Promise<void>;
}

export class MatrixApiError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

interface RawEvent {
  readonly type?: string;
  readonly sender?: string;
  readonly content?: { msgtype?: string; body?: string; membership?: string };
}

interface RoomJoin {
  readonly timeline?: { events?: RawEvent[] };
  readonly state?: { events?: RawEvent[] };
}

function isDirectRoom(room: RoomJoin): boolean {
  const members = (room.state?.events ?? []).filter(
    (e) => e.type === 'm.room.member' && e.content?.membership === 'join',
  );
  return members.length <= 2;
}

function parseSyncBody(body: unknown): MatrixSyncResult {
  const data = body as {
    next_batch?: string;
    rooms?: { join?: Record<string, RoomJoin> };
  };
  const messages: MatrixMessage[] = [];
  const join = data.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(join)) {
    if (!isDirectRoom(room)) continue;
    const isDirect = true;
    for (const ev of room.timeline?.events ?? []) {
      if (ev.type !== 'm.room.message') continue;
      const msgtype = ev.content?.msgtype;
      if (msgtype !== 'm.text' && msgtype !== 'm.notice') continue;
      const text = ev.content?.body;
      if (typeof text !== 'string' || typeof ev.sender !== 'string') continue;
      messages.push({ roomId, sender: ev.sender, body: text, isDirect });
    }
  }
  return { nextBatch: data.next_batch ?? '', messages };
}

export class LiveMatrixClient implements MatrixClient {
  private readonly homeserver: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    homeserverRef: string,
    tokenRef: string,
    opts: { fetchFn?: typeof fetch } = {},
  ) {
    const hs = process.env[homeserverRef];
    const token = process.env[tokenRef];
    if (!hs) throw new Error(`matrix homeserver env not set (ref: ${homeserverRef})`);
    if (!token) throw new Error(`matrix access token env not set (ref: ${tokenRef})`);
    this.homeserver = hs.replace(/\/$/, '');
    this.token = token;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async sync(
    since: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<MatrixSyncResult> {
    const params = new URLSearchParams({ timeout: String(timeoutMs) });
    if (since) params.set('since', since);
    const url = `${this.homeserver}/_matrix/client/v3/sync?${params}`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!res.ok) {
      throw new MatrixApiError(`matrix sync failed: ${res.status}`, res.status >= 500 || res.status === 429);
    }
    return parseSyncBody(await res.json());
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    const txnId = `aegis-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const url = `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
    const res = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ msgtype: 'm.text', body: text }),
    });
    if (!res.ok) {
      throw new MatrixApiError(`matrix send failed: ${res.status}`, res.status >= 500 || res.status === 429);
    }
  }
}

/** @internal test helper */
export function parseMatrixSyncForTest(body: unknown): MatrixSyncResult {
  return parseSyncBody(body);
}
