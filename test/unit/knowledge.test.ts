import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-know-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function memoryDb(): ReturnType<typeof openDb> {
  const db = openDb(join(tmp, `m-${Date.now()}.db`));
  const sql = readFileSync(new URL('../../migrations/0001-memory.sql', import.meta.url), 'utf8');
  applyMigration(db, sql, 1);
  return db;
}

describe('KnowledgeStore', () => {
  it('insert создаёт unverified по умолчанию', () => {
    const db = memoryDb();
    const store = new KnowledgeStore(db, { now: () => NOW });
    const id = store.insert({ title: 'T', body: 'B', provenance: 'owner' });
    const row = db.prepare('SELECT epistemic_status s FROM knowledge WHERE id = ?').get(id) as {
      s: string;
    };
    expect(row.s).toBe('unverified');
    expect(store.listForInjection()).toHaveLength(0);
  });

  it('listForInjection возвращает corroborated и verified', () => {
    const db = memoryDb();
    const store = new KnowledgeStore(db, { now: () => NOW });
    const id = store.insert({ title: 'API', body: 'https://x', provenance: 'owner' });
    db.prepare(
      `INSERT INTO evidence (knowledge_id, evidence_type, summary, created_at)
       VALUES (?, 'test_pass', 'ok', ?)`,
    ).run(id, NOW);
    db.prepare(`UPDATE knowledge SET epistemic_status = 'corroborated' WHERE id = ?`).run(id);
    const injected = store.listForInjection();
    expect(injected).toHaveLength(1);
    expect(injected[0]?.title).toBe('API');
  });

  it('bumpUsage увеличивает use_count', () => {
    const db = memoryDb();
    const store = new KnowledgeStore(db, { now: () => NOW });
    const id = store.insert({ title: 'T', body: 'B', provenance: 'owner' });
    store.bumpUsage(id);
    const row = db.prepare('SELECT use_count c FROM knowledge WHERE id = ?').get(id) as {
      c: number;
    };
    expect(row.c).toBe(1);
  });
});
