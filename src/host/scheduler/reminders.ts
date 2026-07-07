/**
 * One-shot напоминания: /remind → fire_at → outbound (Sprint 13 / F3).
 */
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ReminderRow {
  id: string;
  fireAt: number;
  text: string;
  sessionId: string;
}

export interface ReminderStoreOptions {
  now?: () => number;
}

const REMIND_RE = /^\/remind\s+(\d{1,2}):(\d{2})\s+(.+)$/s;

export function parseRemindCommand(
  text: string,
): { ok: true; hour: number; minute: number; message: string } | { ok: false; reason: string } {
  const m = REMIND_RE.exec(text.trim());
  if (!m) return { ok: false, reason: 'Usage: /remind HH:MM <message>' };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const message = m[3]!.trim();
  if (hour > 23 || minute > 59) return { ok: false, reason: 'Invalid time (use HH:MM UTC)' };
  if (message.length === 0) return { ok: false, reason: 'Reminder message cannot be empty' };
  return { ok: true, hour, minute, message };
}

/** Следующий fire_at (UTC): сегодня в HH:MM или завтра, если время уже прошло. */
export function nextFireAtUtc(hour: number, minute: number, now: Date): number {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

export class ReminderStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: ReminderStoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  add(fireAt: number, text: string, sessionId: string): string {
    const id = randomBytes(4).toString('hex');
    this.db
      .prepare(
        `INSERT INTO reminders (id, fire_at, text, session_id, fired, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(id, fireAt, text, sessionId, this.now());
    return id;
  }

  due(nowMs: number): ReminderRow[] {
    return (
      this.db
        .prepare(
          `SELECT id, fire_at, text, session_id
           FROM reminders WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at`,
        )
        .all(nowMs) as { id: string; fire_at: number; text: string; session_id: string }[]
    ).map((r) => ({
      id: r.id,
      fireAt: r.fire_at,
      text: r.text,
      sessionId: r.session_id,
    }));
  }

  markFired(id: string): void {
    this.db.prepare(`UPDATE reminders SET fired = 1 WHERE id = ?`).run(id);
  }

  countPending(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM reminders WHERE fired = 0`)
      .get() as { c: number };
    return row.c;
  }
}
