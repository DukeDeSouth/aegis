/**
 * Очереди сообщений поверх queue.db (docs/MEMORY_SCHEMA.md, модель SQS):
 * статус выражен временем видимости, claim атомарен (UPDATE … RETURNING).
 * Единственный вход в ядро: adapter (Sprint 2) и scheduler (Sprint 9)
 * публикуют сюда же — привилегированного пути нет.
 */
import type Database from 'better-sqlite3';

export const QUEUE_NAMES = ['inbound', 'outbound'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_PROVENANCES = ['owner', 'quarantine', 'scheduler', 'system'] as const;
export type QueueProvenance = (typeof QUEUE_PROVENANCES)[number];

export interface ClaimedMessage {
  id: number;
  queue: QueueName;
  payload: string;
  provenance: QueueProvenance;
  created_at: number;
  visible_at: number;
  claimed_by: string | null;
  attempts: number;
  max_attempts: number;
  dead: number;
}

export interface QueueStoreOptions {
  visibilityTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_VISIBILITY_TIMEOUT_MS = 60_000;

export class QueueStore {
  private readonly db: Database.Database;
  private readonly visibilityTimeoutMs: number;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: QueueStoreOptions = {}) {
    this.db = db;
    this.visibilityTimeoutMs = opts.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  publish(queue: QueueName, payload: string, provenance: QueueProvenance): number {
    const ts = this.now();
    const res = this.db
      .prepare(
        `INSERT INTO messages (queue, payload, provenance, created_at, visible_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(queue, payload, provenance, ts, ts);
    return Number(res.lastInsertRowid);
  }

  /** Атомарный claim; undefined — очередь пуста. Скрывает сообщение на visibilityTimeout. */
  claim(queue: QueueName, worker: string): ClaimedMessage | undefined {
    const now = this.now();
    return this.db
      .prepare(
        `UPDATE messages
         SET visible_at = :now + :timeout, claimed_by = :worker, attempts = attempts + 1
         WHERE id = (SELECT id FROM messages
                     WHERE queue = :queue AND dead = 0 AND visible_at <= :now
                     ORDER BY created_at LIMIT 1)
         RETURNING *`,
      )
      .get({ now, timeout: this.visibilityTimeoutMs, worker, queue }) as ClaimedMessage | undefined;
  }

  /** Успешная обработка — сообщение удаляется. */
  ack(id: number): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  /** Dead letter: attempts исчерпаны или payload невалиден. Решение принимает вызывающий. */
  markDead(id: number): void {
    this.db.prepare('UPDATE messages SET dead = 1 WHERE id = ?').run(id);
  }

  /** Вернуть сообщение в очередь — другой channel adapter заберёт (не наш session_id). */
  release(id: number): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE messages
         SET visible_at = ?, claimed_by = NULL,
             attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END
         WHERE id = ?`,
      )
      .run(now, id);
  }
}
