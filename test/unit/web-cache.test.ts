import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { urlHash, WebCacheStore } from '../../src/memory/web-cache.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-wcache-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('WebCacheStore', () => {
  it('put/get и isFresh', () => {
    const db = openDb(join(tmp, 'c.db'));
    applyMigration(db, readFileSync(new URL('../../migrations/0001-memory.sql', import.meta.url), 'utf8'), 1);
    applyMigration(db, readFileSync(new URL('../../migrations/0002-memory.sql', import.meta.url), 'utf8'), 2);
    const store = new WebCacheStore(db);
    const hash = urlHash('https://example.com');
    const now = 1_750_000_000_000;
    store.put(hash, 'https://example.com', 'digest text', now);
    const row = store.get(hash);
    expect(row?.digest).toBe('digest text');
    expect(store.isFresh(now, 3600, now + 1000)).toBe(true);
    expect(store.isFresh(now, 3600, now + 3_600_001)).toBe(false);
  });
});
