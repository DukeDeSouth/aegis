/**
 * E2E Sprint 37 / L1: /consolidate + ConsolidationRunner.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { ConsolidationRunner } from '../../src/memory/consolidation.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-consolidation-loop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('consolidation loop (e2e, DoD Sprint 37)', () => {
  it('/consolidate disabled по умолчанию', async () => {
    const queueDb = openDb(join(tmp, 'off-queue.db'));
    const auditDb = openDb(join(tmp, 'off-audit.db'));
    const memoryPath = join(tmp, 'off-memory.db');
    const memoryDb = openDb(memoryPath);
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(memoryDb, migration('0014-memory.sql'), 14);

    const knowledge = new KnowledgeStore(memoryDb, { now: () => NOW });
    const promotion = new PromotionGate(memoryDb, { now: () => NOW });
    const snapshot = new MemorySnapshot(memoryDb, memoryPath, join(tmp, 'off-snaps'), {
      now: () => NOW,
    });
    const consolidation = new ConsolidationRunner(knowledge, promotion, snapshot, {
      complete: () => Promise.reject(new Error('should not call')),
    });

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const llm: LlmClient = {
      complete: () =>
        Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 0, completionTokens: 0, estimated: false },
        }),
    };
    const orch = new Orchestrator(queues, audit, llm, pending, {
      knowledge,
      promotion,
      consolidation,
      learning: { memory_consolidation_enabled: false } as import('../../src/config/schema.ts').LearningConfig,
    });

    queues.publish('inbound', JSON.stringify({ text: '/consolidate', session_id: 'tg:1' }), 'owner');
    await orch.processOne();

    const out = queues.claim('outbound', 'test');
    expect(out).toBeDefined();
    const payload = JSON.parse(out!.payload) as { text: string };
    expect(payload.text).toContain('disabled');
  });

  it('/consolidate сливает corroborated и /verify показывает llm_proposal', async () => {
    const queueDb = openDb(join(tmp, 'on-queue.db'));
    const auditDb = openDb(join(tmp, 'on-audit.db'));
    const memoryPath = join(tmp, 'on-memory.db');
    const memoryDb = openDb(memoryPath);
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(memoryDb, migration('0014-memory.sql'), 14);

    const knowledge = new KnowledgeStore(memoryDb, { now: () => NOW });
    const promotion = new PromotionGate(memoryDb, { now: () => NOW });
    const snapshot = new MemorySnapshot(memoryDb, memoryPath, join(tmp, 'on-snaps'), {
      now: () => NOW,
    });
    const id1 = knowledge.insert({ title: 'Tea', body: 'green tea', provenance: 'owner' });
    const id2 = knowledge.insert({ title: 'Tea2', body: 'likes green tea', provenance: 'owner' });
    promotion.corroborateWithEvidence(id1, 'test_pass', 'ok');
    promotion.corroborateWithEvidence(id2, 'test_pass', 'ok');

    const qLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: {
            role: 'assistant',
            content: JSON.stringify({
              merges: [
                {
                  keep_id: id1,
                  refute_ids: [id1, id2],
                  summary_title: 'Tea preference',
                  summary_body: 'User prefers green tea',
                },
              ],
            }),
          },
          usage: { promptTokens: 20, completionTokens: 10, estimated: false },
        });
      },
    };
    const consolidation = new ConsolidationRunner(knowledge, promotion, snapshot, qLlm);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const pLlm: LlmClient = {
      complete: () =>
        Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 0, completionTokens: 0, estimated: false },
        }),
    };
    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      knowledge,
      promotion,
      consolidation,
      learning: {
        memory_consolidation_enabled: true,
        consolidation_batch_size: 25,
      } as import('../../src/config/schema.ts').LearningConfig,
    });

    queues.publish('inbound', JSON.stringify({ text: '/consolidate', session_id: 'tg:2' }), 'owner');
    await orch.processOne();

    const out1 = queues.claim('outbound', 'test');
    expect(out1).toBeDefined();
    expect(JSON.parse(out1!.payload).text).toContain('Consolidation done');

    const newRow = memoryDb
      .prepare(`SELECT id FROM knowledge WHERE provenance = 'consolidation'`)
      .get() as { id: number };
    expect(newRow.id).toBeGreaterThan(0);

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/verify ${newRow.id}`, session_id: 'tg:2' }),
      'owner',
    );
    await orch.processOne();

    const out2 = queues.claim('outbound', 'test');
    expect(out2).toBeDefined();
    const verifyText = JSON.parse(out2!.payload).text as string;
    expect(verifyText).toContain('verified');
    expect(verifyText).toContain('llm_proposal');
  });
});
