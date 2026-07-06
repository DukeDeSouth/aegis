/**
 * Состояние Telegram-канала поверх channel_state (queue.db, миграция 0002):
 * owner_user_id — результат pairing'а, пишется ровно один раз (защита от переугона);
 * updates_offset — протокол getUpdates, переживает рестарт (at-least-once, см. IMPACT R4).
 */
import type Database from 'better-sqlite3';

export class ChannelState {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getOwnerUserId(): number | undefined {
    return this.read('owner_user_id');
  }

  /** Однократная запись: повторный вызов — ошибка, владелец не перезаписывается. */
  setOwnerUserId(id: number): void {
    if (this.getOwnerUserId() !== undefined) {
      throw new Error('channel already paired: owner_user_id is write-once');
    }
    this.db
      .prepare(`INSERT INTO channel_state (key, value) VALUES ('owner_user_id', ?)`)
      .run(String(id));
  }

  getOffset(): number | undefined {
    return this.read('updates_offset');
  }

  setOffset(value: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_state (key, value) VALUES ('updates_offset', ?)`)
      .run(String(value));
  }

  private read(key: string): number | undefined {
    const row = this.db.prepare('SELECT value FROM channel_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return undefined;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : undefined;
  }
}
