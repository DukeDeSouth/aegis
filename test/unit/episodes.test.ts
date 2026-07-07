import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore, escapeFtsQuery } from '../../src/memory/episodes.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-ep-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function memoryDb(): ReturnType<typeof openDb> {
  const db = openDb(join(tmp, `m-${Date.now()}.db`));
  const sql = readFileSync(new URL('../../migrations/0001-memory.sql', import.meta.url), 'utf8');
  applyMigration(db, sql, 1);
  return db;
}

describe('EpisodeStore', () => {
  it('append + search находит по FTS без LLM', () => {
    const db = memoryDb();
    const store = new EpisodeStore(db, { now: () => NOW });
    store.append('s1', 'owner', 'встреча с бухгалтером в четверг', 'owner');
    const hits = store.search('бухгалтером');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain('бухгалтером');
  });

  it('search с пустым query возвращает []', () => {
    const db = memoryDb();
    const store = new EpisodeStore(db, { now: () => NOW });
    expect(store.search('   ')).toEqual([]);
  });

  it('listBySession возвращает эпизоды сессии', () => {
    const db = memoryDb();
    const store = new EpisodeStore(db, { now: () => NOW });
    store.append('s1', 'owner', 'a', 'owner');
    store.append('s2', 'owner', 'b', 'owner');
    expect(store.listBySession('s1')).toHaveLength(1);
  });

  it('tailBySession возвращает последние N в хронологическом порядке', () => {
    const db = memoryDb();
    const store = new EpisodeStore(db, { now: () => NOW });
    store.append('s1', 'owner', 'first', 'owner');
    store.append('s1', 'assistant', 'second', 'orchestrator');
    store.append('s1', 'owner', 'third', 'owner');
    const tail = store.tailBySession('s1', 2);
    expect(tail).toHaveLength(2);
    expect(tail[0]?.content).toBe('second');
    expect(tail[1]?.content).toBe('third');
  });

  it('tailBySession limit 0 → []', () => {
    const db = memoryDb();
    const store = new EpisodeStore(db, { now: () => NOW });
    store.append('s1', 'owner', 'a', 'owner');
    expect(store.tailBySession('s1', 0)).toEqual([]);
  });
});

describe('escapeFtsQuery', () => {
  it('оборачивает токены в кавычки', () => {
    expect(escapeFtsQuery('hello world')).toBe('"hello" "world"');
  });
});
