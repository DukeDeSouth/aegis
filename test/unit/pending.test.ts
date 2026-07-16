import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-pending-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('PendingStore', () => {
  it('create + consume одноразово', () => {
    const db = openDb(join(tmp, 'once.db'));
    applyMigration(db, migration('0001-queue.sql'), 1);
    applyMigration(db, migration('0003-queue.sql'), 3);
    applyMigration(db, migration('0009-queue.sql'), 9);
    const store = new PendingStore(db, { now: () => 1000, ttlMs: 60_000 });

    const token = store.create('action.dangerous', { x: 1 }, 'tg:42', 'discord');
    expect(token).toMatch(/^[0-9a-f]{8}$/);

    const r = store.consume(token);
    expect(r?.actionId).toBe('action.dangerous');
    expect(JSON.parse(r!.payload)).toEqual({ x: 1 });
    expect(r?.chatId).toBe(42);
    expect(r?.originSessionId).toBe('tg:42');
    expect(r?.requiredChannel).toBe('discord');

    expect(store.consume(token)).toBeNull();
  });

  it('истёкший token → null', () => {
    const db = openDb(join(tmp, 'exp.db'));
    applyMigration(db, migration('0001-queue.sql'), 1);
    applyMigration(db, migration('0003-queue.sql'), 3);
    applyMigration(db, migration('0009-queue.sql'), 9);
    let now = 1000;
    const store = new PendingStore(db, { now: () => now, ttlMs: 100 });

    const token = store.create('action.dangerous', {}, 'tg:1', null);
    now = 2000;
    expect(store.consume(token)).toBeNull();
  });
});
