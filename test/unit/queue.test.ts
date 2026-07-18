import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QueueStore } from '../../src/host/queue/store.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-queue-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const migrationSql = readFileSync(
  new URL('../../migrations/0001-queue.sql', import.meta.url),
  'utf8',
);

function makeStore(name: string, nowRef: { value: number }): QueueStore {
  const db = openDb(join(tmp, name));
  applyMigration(db, migrationSql, 1);
  return new QueueStore(db, { visibilityTimeoutMs: 30_000, now: () => nowRef.value });
}

describe('QueueStore', () => {
  it('publish → claim → ack: сообщение проходит и удаляется', () => {
    const now = { value: 1_000 };
    const store = makeStore('happy.db', now);
    const id = store.publish('inbound', '{"x":1}', 'owner');

    const claimed = store.claim('inbound', 'w1');
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimed_by).toBe('w1');

    store.ack(id);
    now.value += 100_000;
    expect(store.claim('inbound', 'w1')).toBeUndefined();
  });

  it('конкуренция: второй claim при одном сообщении получает undefined', () => {
    const now = { value: 1_000 };
    const store = makeStore('race.db', now);
    store.publish('inbound', '{}', 'owner');

    expect(store.claim('inbound', 'w1')).toBeDefined();
    expect(store.claim('inbound', 'w2')).toBeUndefined();
  });

  it('возврат по visibility timeout: не-ack\u0027нутое сообщение снова доступно', () => {
    const now = { value: 1_000 };
    const store = makeStore('timeout.db', now);
    store.publish('inbound', '{}', 'owner');

    const first = store.claim('inbound', 'w1');
    expect(first?.attempts).toBe(1);

    now.value += 30_001;
    const second = store.claim('inbound', 'w2');
    expect(second?.id).toBe(first?.id);
    expect(second?.attempts).toBe(2);
  });

  it('очереди изолированы: claim outbound не видит inbound', () => {
    const now = { value: 1_000 };
    const store = makeStore('isolation.db', now);
    store.publish('inbound', '{}', 'owner');
    expect(store.claim('outbound', 'w1')).toBeUndefined();
  });

  it('markDead: мёртвое сообщение больше не выдаётся', () => {
    const now = { value: 1_000 };
    const store = makeStore('dead.db', now);
    const id = store.publish('inbound', '{}', 'owner');

    store.claim('inbound', 'w1');
    store.markDead(id);
    now.value += 100_000;
    expect(store.claim('inbound', 'w1')).toBeUndefined();
  });

  it('release: сообщение снова доступно другому worker', () => {
    const now = { value: 1_000 };
    const store = makeStore('release.db', now);
    const id = store.publish('outbound', '{"text":"hi","session_id":"webchat:local"}', 'system');

    const claimed = store.claim('outbound', 'telegram');
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1);
    store.release(id);
    const again = store.claim('outbound', 'webchat');
    expect(again?.id).toBe(id);
    expect(again?.attempts).toBe(1);
  });

  it('FIFO: сообщения выдаются в порядке created_at', () => {
    const now = { value: 1_000 };
    const store = makeStore('fifo.db', now);
    const first = store.publish('inbound', '{"n":1}', 'owner');
    now.value += 10;
    store.publish('inbound', '{"n":2}', 'owner');

    expect(store.claim('inbound', 'w1')?.id).toBe(first);
  });
});
