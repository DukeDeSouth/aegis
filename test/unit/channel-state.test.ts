import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-chstate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function makeDb(name: string, withF10 = false): Database.Database {
  const db = openDb(join(tmp, name));
  applyMigration(db, migration('0001-queue.sql'), 1);
  applyMigration(db, migration('0002-queue.sql'), 2);
  if (withF10) applyMigration(db, migration('0008-queue.sql'), 8);
  return db;
}

describe('ChannelState', () => {
  it('пустое состояние: owner и offset отсутствуют', () => {
    const state = new ChannelState(makeDb('empty.db'));
    expect(state.getOwnerUserId()).toBeUndefined();
    expect(state.getOffset()).toBeUndefined();
  });

  it('pairing переживает рестарт: новая инстанция на той же БД видит владельца', () => {
    const db = makeDb('restart.db');
    new ChannelState(db).setOwnerUserId(42);

    const reopened = new ChannelState(db);
    expect(reopened.getOwnerUserId()).toBe(42);
  });

  it('owner_user_id write-once: повторная запись кидает (защита от переугона)', () => {
    const state = new ChannelState(makeDb('once.db'));
    state.setOwnerUserId(42);
    expect(() => state.setOwnerUserId(99)).toThrow(/already paired/);
    expect(state.getOwnerUserId()).toBe(42);
  });

  it('offset перезаписывается и переживает рестарт', () => {
    const db = makeDb('offset.db');
    const state = new ChannelState(db);
    state.setOffset(100);
    state.setOffset(200);
    expect(new ChannelState(db).getOffset()).toBe(200);
  });

  it('большие telegram id (> 2^31) сохраняются без потерь', () => {
    const state = new ChannelState(makeDb('bigid.db'));
    const bigId = 7_222_333_444_555;
    state.setOwnerUserId(bigId);
    expect(state.getOwnerUserId()).toBe(bigId);
  });

  it('CHECK на key: посторонний ключ отклоняется схемой', () => {
    const db = makeDb('check.db');
    expect(() =>
      db.prepare(`INSERT INTO channel_state (key, value) VALUES ('random_key', 'x')`).run(),
    ).toThrow();
  });

  it('F10: discord и email ключи write-once / перезапись', () => {
    const db = makeDb('f10.db', true);
    const state = new ChannelState(db);
    state.setDiscordOwnerId('discord-user-1');
    expect(state.getDiscordOwnerId()).toBe('discord-user-1');
    expect(() => state.setDiscordOwnerId('other')).toThrow(/already paired/);

    state.setDiscordLastSequence(42);
    state.setDiscordLastSequence(99);
    expect(state.getDiscordLastSequence()).toBe(99);

    state.setEmailLastUid(7);
    state.setEmailLastUid(8);
    expect(state.getEmailLastUid()).toBe(8);
  });
});
