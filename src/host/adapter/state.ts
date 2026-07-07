/**
 * channel_state (queue.db): namespaced keys per channel (F10).
 */
import type Database from 'better-sqlite3';

export class ChannelState {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getOwnerUserId(): number | undefined {
    return this.readNumber('owner_user_id');
  }

  setOwnerUserId(id: number): void {
    this.writeOnce('owner_user_id', String(id));
  }

  getOffset(): number | undefined {
    return this.readNumber('updates_offset');
  }

  setOffset(value: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_state (key, value) VALUES ('updates_offset', ?)`)
      .run(String(value));
  }

  getDiscordOwnerId(): string | undefined {
    return this.readString('discord_owner_user_id');
  }

  setDiscordOwnerId(id: string): void {
    this.writeOnce('discord_owner_user_id', id);
  }

  getDiscordLastSequence(): number | undefined {
    return this.readNumber('discord_last_sequence');
  }

  setDiscordLastSequence(seq: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO channel_state (key, value) VALUES ('discord_last_sequence', ?)`,
      )
      .run(String(seq));
  }

  getEmailLastUid(): number | undefined {
    return this.readNumber('email_last_uid');
  }

  setEmailLastUid(uid: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_state (key, value) VALUES ('email_last_uid', ?)`)
      .run(String(uid));
  }

  private writeOnce(key: string, value: string): void {
    if (this.readString(key) !== undefined) {
      throw new Error(`channel already paired: ${key} is write-once`);
    }
    this.db.prepare(`INSERT INTO channel_state (key, value) VALUES (?, ?)`).run(key, value);
  }

  private readNumber(key: string): number | undefined {
    const s = this.readString(key);
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }

  private readString(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM channel_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}
