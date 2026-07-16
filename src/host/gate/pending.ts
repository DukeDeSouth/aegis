/**
 * Human-gate: персистенция отложенных необратимых действий (queue.db, 0003-queue.sql).
 */
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApproveChannel } from './channels.ts';

export interface PendingRecord {
  token: string;
  actionId: string;
  payload: string;
  chatId: number;
  originSessionId: string;
  requiredChannel: ApproveChannel | null;
}

export interface PendingStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

function legacyChatId(originSessionId: string): number {
  if (!originSessionId.startsWith('tg:')) return 0;
  const n = Number(originSessionId.slice(3));
  return Number.isSafeInteger(n) ? n : 0;
}

type Row = {
  token: string;
  action_id: string;
  payload: string;
  chat_id: number;
  origin_session_id: string | null;
  required_channel: string | null;
  expires_at: number;
  consumed: number;
};

function mapRow(row: Row): PendingRecord {
  const req = row.required_channel;
  const requiredChannel =
    req === 'telegram' || req === 'discord' || req === 'totp' ? req : null;
  return {
    token: row.token,
    actionId: row.action_id,
    payload: row.payload,
    chatId: row.chat_id,
    originSessionId: row.origin_session_id ?? `tg:${row.chat_id}`,
    requiredChannel,
  };
}

export class PendingStore {
  private readonly db: Database.Database;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly has2faCols: boolean;

  constructor(db: Database.Database, opts: PendingStoreOptions = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    const cols = db.prepare('PRAGMA table_info(pending_actions)').all() as { name: string }[];
    this.has2faCols = cols.some((c) => c.name === 'origin_session_id');
  }

  create(
    actionId: string,
    payload: unknown,
    originSessionId: string,
    requiredChannel: ApproveChannel | null,
  ): string {
    const token = randomBytes(4).toString('hex');
    const ts = this.now();
    const chatId = legacyChatId(originSessionId);
    if (this.has2faCols) {
      this.db
        .prepare(
          `INSERT INTO pending_actions
           (token, action_id, payload, chat_id, origin_session_id, required_channel, created_at, expires_at, consumed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          token,
          actionId,
          JSON.stringify(payload),
          chatId,
          originSessionId,
          requiredChannel,
          ts,
          ts + this.ttlMs,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO pending_actions (token, action_id, payload, chat_id, created_at, expires_at, consumed)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(token, actionId, JSON.stringify(payload), chatId, ts, ts + this.ttlMs);
    }
    return token;
  }

  peek(token: string): PendingRecord | null {
    const row = this.db
      .prepare(
        this.has2faCols
          ? `SELECT token, action_id, payload, chat_id, origin_session_id, required_channel, expires_at, consumed
             FROM pending_actions WHERE token = ?`
          : `SELECT token, action_id, payload, chat_id, expires_at, consumed
             FROM pending_actions WHERE token = ?`,
      )
      .get(token) as Row | Omit<Row, 'origin_session_id' | 'required_channel'> | undefined;
    if (!row || row.consumed !== 0 || row.expires_at < this.now()) return null;
    if (this.has2faCols) return mapRow(row as Row);
    const legacy = row as Omit<Row, 'origin_session_id' | 'required_channel'>;
    return {
      token: legacy.token,
      actionId: legacy.action_id,
      payload: legacy.payload,
      chatId: legacy.chat_id,
      originSessionId: legacy.chat_id ? `tg:${legacy.chat_id}` : '',
      requiredChannel: null,
    };
  }

  consume(token: string): PendingRecord | null {
    const row = this.peek(token);
    if (!row) return null;
    const updated = this.db
      .prepare(`UPDATE pending_actions SET consumed = 1 WHERE token = ? AND consumed = 0`)
      .run(token);
    if (updated.changes !== 1) return null;
    return row;
  }

  countActive(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM pending_actions WHERE consumed = 0 AND expires_at > ?`,
      )
      .get(this.now()) as { c: number };
    return row.c;
  }
}
