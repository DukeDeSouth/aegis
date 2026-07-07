/**
 * E2E Sprint 10: /metrics + learning policy блокирует scheduler LLM.
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
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { computeReuseMetrics } from '../../src/memory/metrics.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-metrics-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

interface World {
  queues: QueueStore;
  audit: AuditLog;
  auditDb: Database.Database;
  memoryDb: Database.Database;
  queueDb: Database.Database;
  knowledge: KnowledgeStore;
}

function makeWorld(name: string): World {
  const queueDb = openDb(join(tmp, `${name}-queue.db`));
  const auditDb = openDb(join(tmp, `${name}-audit.db`));
  const memoryDb = openDb(join(tmp, `${name}-memory.db`));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  applyMigration(memoryDb, migration('0001-memory.sql'), 1);
  return {
    queues: new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW }),
    audit: new AuditLog(auditDb, { now: () => NOW }),
    auditDb,
    memoryDb,
    queueDb,
    knowledge: new KnowledgeStore(memoryDb, { now: () => NOW }),
  };
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('metrics loop (e2e, Sprint 10)', () => {
  it('owner /metrics → reuse_rate в outbound + audit', async () => {
    const w = makeWorld('metrics');
    const id = w.knowledge.insert({
      title: 'fact',
      body: 'data',
      provenance: 'owner',
      epistemicStatus: 'corroborated',
    });
    w.knowledge.bumpUsage(id);
    w.knowledge.insert({
      title: 'unused',
      body: 'never injected',
      provenance: 'owner',
      epistemicStatus: 'corroborated',
    });

    w.queues.publish('inbound', JSON.stringify({ text: '/metrics', session_id: 'tg:1' }), 'owner');

    await new Orchestrator(
      w.queues,
      w.audit,
      { complete: () => Promise.reject(new Error('no')) },
      new PendingStore(w.queueDb),
      {
        getReuseMetrics: () => computeReuseMetrics(w.memoryDb),
        learning: {
          self_improvement_llm_enabled: false,
          min_reuse_rate: 0,
          skill_proposal_threshold: 3,
          skill_proposal_window_days: 14,
          skill_curator_stale_days: 30,
          skill_curator_min_success_rate: 0.5,
        },
      },
    ).processOne();

    const out = w.queues.claim('outbound', 'p');
    expect(out).toBeDefined();
    const { text } = JSON.parse(out!.payload) as { text: string };
    expect(text).toContain('Reuse rate');
    expect(text).toContain('50%');
    expect(auditActions(w.auditDb)).toContain('metrics.reported');
  });

  it('scheduler LLM при self_improvement_llm_enabled=false → notify, без LLM', async () => {
    const w = makeWorld('learning-block');
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: 'Generate digest', session_id: 'scheduler:digest' }),
      'scheduler',
    );

    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.reject(new Error('LLM must not run'));
      },
    };

    await new Orchestrator(w.queues, w.audit, llm, new PendingStore(w.queueDb), {
      getReuseMetrics: () => computeReuseMetrics(w.memoryDb),
      ownerNotifySessionId: 'tg:99',
      learning: {
        self_improvement_llm_enabled: false,
        min_reuse_rate: 0,
        skill_proposal_threshold: 3,
        skill_proposal_window_days: 14,
        skill_curator_stale_days: 30,
        skill_curator_min_success_rate: 0.5,
      },
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    }).processOne();

    const out = w.queues.claim('outbound', 'p');
    expect(out).toBeDefined();
    const { text } = JSON.parse(out!.payload) as { text: string };
    expect(text.toLowerCase()).toContain('self-improvement');
    expect(auditActions(w.auditDb)).toContain('learning.llm_blocked');
    expect(auditActions(w.auditDb)).not.toContain('llm.completed');
  });
});
