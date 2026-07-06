/**
 * Human-gate: персистенция отложенных необратимых действий (queue.db, 0003-queue.sql).
 */
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface PendingRecord {
  token: string;
  actionId: string;
  payload: string;
  chatId: number;
}

export interface PendingStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class PendingStore {
  private readonly db: Database.Database;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: PendingStoreOptions = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Создаёт pending и возвращает одноразовый token (8 hex-символов). */
  create(actionId: string, payload: unknown, chatId: number): string {
    const token = randomBytes(4).toString('hex');
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO pending_actions (token, action_id, payload, chat_id, created_at, expires_at, consumed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(token, actionId, JSON.stringify(payload), chatId, ts, ts + this.ttlMs);
    return token;
  }

  /** Атомарно потребляет token; null — не найден, истёк или уже использован. */
  consume(token: string): PendingRecord | null {
    const row = this.db
      .prepare(
        `SELECT token, action_id, payload, chat_id, expires_at, consumed
         FROM pending_actions WHERE token = ?`,
      )
      .get(token) as
      | {
          token: string;
          action_id: string;
          payload: string;
          chat_id: number;
          expires_at: number;
          consumed: number;
        }
      | undefined;

    if (row?.consumed !== 0 || (row?.expires_at ?? 0) < this.now()) return null;

    const updated = this.db
      .prepare(`UPDATE pending_actions SET consumed = 1 WHERE token = ? AND consumed = 0`)
      .run(token);
    if (updated.changes !== 1) return null;

    return {
      token: row.token,
      actionId: row.action_id,
      payload: row.payload,
      chatId: row.chat_id,
    };
  }
}
