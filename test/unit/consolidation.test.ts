import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ConsolidationRunner,
  parseConsolidationPlan,
  validateConsolidationPlan,
} from '../../src/memory/consolidation.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';
import type { LlmClient } from '../../src/llm/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-consolidation-unit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function memoryWorld(name: string) {
  const memoryPath = join(tmp, `${name}.db`);
  const db = openDb(memoryPath);
  applyMigration(db, migration('0001-memory.sql'), 1);
  applyMigration(db, migration('0014-memory.sql'), 14);
  const knowledge = new KnowledgeStore(db, { now: () => NOW });
  const promotion = new PromotionGate(db, { now: () => NOW });
  const snapshot = new MemorySnapshot(db, memoryPath, join(tmp, `${name}-snaps`), {
    now: () => NOW,
  });
  return { db, knowledge, promotion, snapshot };
}

function corroborate(promotion: PromotionGate, knowledgeId: number): void {
  promotion.corroborateWithEvidence(knowledgeId, 'test_pass', 'unit test');
}

describe('consolidation parser', () => {
  it('parseConsolidationPlan принимает чистый JSON', () => {
    const plan = parseConsolidationPlan(
      '{"merges":[{"keep_id":1,"refute_ids":[1,2],"summary_title":"T","summary_body":"B"}]}',
    );
    expect(plan.merges).toHaveLength(1);
  });

  it('parseConsolidationPlan извлекает JSON из обёртки', () => {
    const plan = parseConsolidationPlan('Here:\n{"merges":[]}');
    expect(plan.merges).toEqual([]);
  });

  it('validateConsolidationPlan отклоняет keep_id вне refute_ids', () => {
    expect(() =>
      validateConsolidationPlan(
        { merges: [{ keep_id: 1, refute_ids: [2], summary_title: 'T', summary_body: 'B' }] },
        new Set([1, 2]),
      ),
    ).toThrow(/keep_id/);
  });

  it('validateConsolidationPlan отклоняет дубли refute_ids', () => {
    expect(() =>
      validateConsolidationPlan(
        {
          merges: [
            { keep_id: 1, refute_ids: [1, 2], summary_title: 'A', summary_body: 'a' },
            { keep_id: 3, refute_ids: [3, 2], summary_title: 'B', summary_body: 'b' },
          ],
        },
        new Set([1, 2, 3]),
      ),
    ).toThrow(/duplicate/);
  });
});

describe('ConsolidationRunner', () => {
  it('run без batch (<2 corroborated) — no-op', async () => {
    const w = memoryWorld('noop');
    const id = w.knowledge.insert({ title: 'Only', body: 'one', provenance: 'owner' });
    corroborate(w.promotion, id);
    const qLlm: LlmClient = {
      complete: vi.fn(),
    };
    const runner = new ConsolidationRunner(w.knowledge, w.promotion, w.snapshot, qLlm);
    const result = await runner.run();
    expect(result.merged).toBe(0);
    expect(qLlm.complete).not.toHaveBeenCalled();
  });

  it('run применяет merge: refute + unverified consolidation', async () => {
    const w = memoryWorld('apply');
    const id1 = w.knowledge.insert({ title: 'Coffee A', body: 'likes espresso', provenance: 'owner' });
    const id2 = w.knowledge.insert({ title: 'Coffee B', body: 'drinks espresso', provenance: 'owner' });
    corroborate(w.promotion, id1);
    corroborate(w.promotion, id2);

    const qLlm: LlmClient = {
      complete: () =>
        Promise.resolve({
          message: {
            role: 'assistant',
            content: JSON.stringify({
              merges: [
                {
                  keep_id: id1,
                  refute_ids: [id1, id2],
                  summary_title: 'Coffee preference',
                  summary_body: 'User likes espresso',
                },
              ],
            }),
          },
          usage: { promptTokens: 10, completionTokens: 5, estimated: false },
        }),
    };
    const runner = new ConsolidationRunner(w.knowledge, w.promotion, w.snapshot, qLlm);
    const result = await runner.run();
    expect(result.merged).toBe(1);
    expect(result.refuted).toBe(2);
    expect(result.newKnowledgeIds).toHaveLength(1);

    const newId = result.newKnowledgeIds[0]!;
    const row = w.db.prepare('SELECT epistemic_status s, provenance p FROM knowledge WHERE id = ?').get(newId) as {
      s: string;
      p: string;
    };
    expect(row).toEqual({ s: 'unverified', p: 'consolidation' });
    expect(w.knowledge.listForInjection()).toHaveLength(0);

    const ev = w.db
      .prepare(`SELECT evidence_type t FROM evidence WHERE knowledge_id = ?`)
      .get(newId) as { t: string };
    expect(ev.t).toBe('llm_proposal');
  });
});
