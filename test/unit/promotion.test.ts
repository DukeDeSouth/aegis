import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-promo-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function db(): ReturnType<typeof openDb> {
  const d = openDb(join(tmp, `p-${Date.now()}.db`));
  const sql = readFileSync(new URL('../../migrations/0001-memory.sql', import.meta.url), 'utf8');
  applyMigration(d, sql, 1);
  return d;
}

function insertKnowledge(d: ReturnType<typeof openDb>): number {
  const res = d
    .prepare(
      `INSERT INTO knowledge (kind, title, body, provenance, created_at, updated_at)
       VALUES ('fact', 'T', 'body', 'owner', ?, ?)`,
    )
    .run(NOW, NOW);
  return Number(res.lastInsertRowid);
}

describe('PromotionGate', () => {
  it('corroborateWithEvidence пишет transition и меняет статус', () => {
    const d = db();
    const gate = new PromotionGate(d, { now: () => NOW });
    const id = insertKnowledge(d);
    gate.corroborateWithEvidence(id, 'test_pass', 'green');
    expect(d.prepare('SELECT epistemic_status s FROM knowledge WHERE id = ?').get(id)).toEqual({
      s: 'corroborated',
    });
    const tr = d
      .prepare('SELECT from_status, to_status, gate FROM status_transitions WHERE knowledge_id = ?')
      .get(id) as { from_status: string; to_status: string; gate: string };
    expect(tr).toEqual({
      from_status: 'unverified',
      to_status: 'corroborated',
      gate: 'auto_corroborate',
    });
  });

  it('verifyByOwner требует owner_confirmation (триггер)', () => {
    const d = db();
    const gate = new PromotionGate(d, { now: () => NOW });
    const id = insertKnowledge(d);
    gate.verifyByOwner(id);
    expect(d.prepare('SELECT epistemic_status s FROM knowledge WHERE id = ?').get(id)).toEqual({
      s: 'verified',
    });
  });

  it('без evidence нельзя corroborate (триггер)', () => {
    const d = db();
    const gate = new PromotionGate(d, { now: () => NOW });
    const id = insertKnowledge(d);
    expect(() => gate.promote(id, 'corroborated', 'auto_corroborate')).toThrow(
      /deterministic evidence/,
    );
  });

  it('refute пишет refuted', () => {
    const d = db();
    const gate = new PromotionGate(d, { now: () => NOW });
    const id = insertKnowledge(d);
    gate.refute(id, 'decay', 'unused');
    expect(d.prepare('SELECT epistemic_status s FROM knowledge WHERE id = ?').get(id)).toEqual({
      s: 'refuted',
    });
  });
});
