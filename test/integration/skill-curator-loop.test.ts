/**
 * E2E Sprint 16 / F6: curate-skills → archive → unarchive.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';
import { SkillCurator } from '../../src/skills/curator.ts';
import { SkillMetricsStore } from '../../src/skills/metrics.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';

const root = mkdtempSync(join(tmpdir(), 'aegis-curator-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('skill curator loop (F6)', () => {
  it('archive removes skill from /skills; unarchive restores', async () => {
    const skillsDir = join(root, 'skills');
    cpSync(join(process.cwd(), 'skills/echo-procedure'), join(skillsDir, 'echo-procedure'), {
      recursive: true,
    });
    const memPath = join(root, 'mem.db');
    const memoryDb = openDb(memPath);
    const queueDb = openDb(join(root, 'q.db'));
    const auditDb = openDb(join(root, 'a.db'));
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(memoryDb, migration('0007-memory.sql'), 7);
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const registry = new SkillRegistry(skillsDir);
    const metrics = new SkillMetricsStore(memoryDb, { now: () => NOW });
    const snapshot = new MemorySnapshot(memoryDb, memPath, join(root, 'snap'));
    const curator = new SkillCurator(metrics, registry, snapshot, {
      skillsDir,
      staleDays: 30,
      now: () => NOW,
    });

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1 },
        });
      },
    };
    const orch = new Orchestrator(queues, audit, llm, pending, {
      skills: registry,
      skillMetrics: metrics,
      skillCurator: curator,
    });

    expect(registry.has('echo-procedure')).toBe(true);

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/skill-archive echo-procedure', session_id: 'tg:1' }),
      'owner',
    );
    await orch.processOne();
    registry.reload();
    expect(registry.has('echo-procedure')).toBe(false);
    expect(existsSync(join(skillsDir, '.archive', 'echo-procedure'))).toBe(true);

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/skill-unarchive echo-procedure', session_id: 'tg:1' }),
      'owner',
    );
    await orch.processOne();
    registry.reload();
    expect(registry.has('echo-procedure')).toBe(true);
  });
});
