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

  isWebchatPaired(): boolean {
    return this.readString('webchat_paired') === '1';
  }

  setWebchatPaired(): void {
    this.writeOnce('webchat_paired', '1');
  }

  getWebchatSessionToken(): string | undefined {
    return this.readString('webchat_session_token');
  }

  setWebchatSessionToken(token: string): void {
    this.writeOnce('webchat_session_token', token);
  }

  /** Re-issue browser session after pairing code re-check (paired flag stays write-once). */
  replaceWebchatSessionToken(token: string): void {
    if (!this.isWebchatPaired()) {
      throw new Error('webchat not paired');
    }
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_state (key, value) VALUES ('webchat_session_token', ?)`)
      .run(token);
  }

  getMatrixOwnerUserId(): string | undefined {
    return this.readString('matrix_owner_user_id');
  }

  setMatrixOwnerUserId(id: string): void {
    this.writeOnce('matrix_owner_user_id', id);
  }

  getMatrixSyncToken(): string | undefined {
    return this.readString('matrix_sync_token');
  }

  setMatrixSyncToken(token: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_state (key, value) VALUES ('matrix_sync_token', ?)`)
      .run(token);
  }

  getSlackOwnerUserId(): string | undefined {
    return this.readString('slack_owner_user_id');
  }

  setSlackOwnerUserId(id: string): void {
    this.writeOnce('slack_owner_user_id', id);
  }

  getVoiceReply(sessionId: string): boolean {
    return this.readString(`voice_reply:${sessionId}`) === '1';
  }

  setVoiceReply(sessionId: string, enabled: boolean): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_state (key, value) VALUES (?, ?)`)
      .run(`voice_reply:${sessionId}`, enabled ? '1' : '0');
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
