import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { CurationRunner, normalizeKey } from '../../src/memory/curation.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-cur-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function runner(decayDays = 90) {
  const dbPath = join(tmp, `c-${Date.now()}.db`);
  const snapDir = join(tmp, `snaps-${Date.now()}`);
  const d = openDb(dbPath);
  const sql = readFileSync(new URL('../../migrations/0001-memory.sql', import.meta.url), 'utf8');
  applyMigration(d, sql, 1);
  const knowledge = new KnowledgeStore(d, { now: () => NOW });
  const promotion = new PromotionGate(d, { now: () => NOW });
  const snapshot = new MemorySnapshot(d, dbPath, snapDir, { now: () => NOW });
  const curation = new CurationRunner(d, knowledge, promotion, snapshot, {
    now: () => NOW,
    decayDays,
  });
  return { d, curation };
}

describe('CurationRunner', () => {
  it('refute stale_after', () => {
    const { d, curation } = runner();
    d.prepare(
      `INSERT INTO knowledge (kind, title, body, provenance, stale_after, created_at, updated_at)
       VALUES ('fact', 'Old', 'x', 'owner', ?, ?, ?)`,
    ).run(NOW - 1, NOW - 100_000, NOW - 100_000);
    const result = curation.run();
    expect(result.staleRefuted).toBe(1);
    expect(d.prepare(`SELECT epistemic_status s FROM knowledge`).get()).toEqual({ s: 'refuted' });
  });

  it('dedup оставляет max(id)', () => {
    const { d, curation } = runner();
    const ins = d.prepare(
      `INSERT INTO knowledge (kind, title, body, provenance, created_at, updated_at)
       VALUES ('fact', ?, ?, 'owner', ?, ?)`,
    );
    ins.run('Same', 'Body', NOW, NOW);
    ins.run(' same ', '  body  ', NOW, NOW);
    const result = curation.run();
    expect(result.dedupRefuted).toBe(1);
    const active = d
      .prepare(`SELECT COUNT(*) c FROM knowledge WHERE epistemic_status != 'refuted'`)
      .get() as {
      c: number;
    };
    expect(active.c).toBe(1);
  });

  it('decay refute unused old', () => {
    const { d, curation } = runner(1);
    const old = NOW - 2 * 24 * 60 * 60 * 1000;
    d.prepare(
      `INSERT INTO knowledge (kind, title, body, provenance, use_count, created_at, updated_at)
       VALUES ('fact', 'Forgotten', 'x', 'owner', 0, ?, ?)`,
    ).run(old, old);
    const result = curation.run();
    expect(result.decayRefuted).toBe(1);
  });
});

describe('normalizeKey', () => {
  it('нормализует пробелы и регистр', () => {
    expect(normalizeKey(' Hello ', '  World  ')).toBe(normalizeKey('hello', 'world'));
  });
});
