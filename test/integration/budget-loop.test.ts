/**
 * E2E Sprint 9 / V7: исчерпание бюджета → уведомление + деградация (не тихий сбой).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { BudgetEngine } from '../../src/host/budget/engine.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-budget-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

interface World {
  queues: QueueStore;
  audit: AuditLog;
  auditDb: Database.Database;
  queueDb: Database.Database;
  budget: BudgetEngine;
}

function makeWorld(name: string): World {
  const queueDb = openDb(join(tmp, `${name}-queue.db`));
  const auditDb = openDb(join(tmp, `${name}-audit.db`));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(queueDb, migration('0004-budget.sql'), 4);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  const budget = new BudgetEngine(queueDb, {
    dailyTokenLimit: 1000,
    reserveForOwner: 200,
    now: () => NOW,
  });
  return {
    queues: new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW }),
    audit: new AuditLog(auditDb, { now: () => NOW }),
    auditDb,
    queueDb,
    budget,
  };
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('budget loop (e2e, V7 / Sprint 9)', () => {
  it('scheduler + исчерпанный бюджет → notify owner, без llm.invoke', async () => {
    const w = makeWorld('v7');
    w.budget.recordUsage({ promptTokens: 900, completionTokens: 0, estimated: false });

    w.queues.publish(
      'inbound',
      JSON.stringify({
        text: 'Generate morning digest',
        session_id: 'scheduler:digest',
      }),
      'scheduler',
    );

    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.reject(new Error('LLM must not run'));
      },
    };

    const orch = new Orchestrator(w.queues, w.audit, llm, new PendingStore(w.queueDb), {
      budget: w.budget,
      ownerNotifySessionId: 'tg:99',
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    await orch.processOne();

    const out = w.queues.claim('outbound', 'probe');
    expect(out).toBeDefined();
    const { text } = JSON.parse(out!.payload) as { text: string; session_id: string };
    expect(text.toLowerCase()).toContain('budget');
    expect(text.toLowerCase()).toContain('exhausted');
    expect(auditActions(w.auditDb)).toContain('budget.degraded');
    expect(auditActions(w.auditDb)).not.toContain('llm.completed');
  });

  it('scheduler + budget OK → llm.invoke разрешён gate', async () => {
    const w = makeWorld('ok');
    let called = false;
    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        called = true;
        return Promise.resolve({
          message: { role: 'assistant', content: 'digest' },
          usage: { promptTokens: 10, completionTokens: 5, estimated: false },
        });
      },
    };

    w.queues.publish(
      'inbound',
      JSON.stringify({ text: 'digest', session_id: 'scheduler:digest' }),
      'scheduler',
    );

    await new Orchestrator(w.queues, w.audit, llm, new PendingStore(w.queueDb), {
      budget: w.budget,
      ownerNotifySessionId: 'tg:99',
      maxTokens: 100,
      learning: {
        self_improvement_llm_enabled: true,
        min_reuse_rate: 0,
        skill_proposal_threshold: 3,
        skill_proposal_window_days: 14,
        skill_curator_stale_days: 30,
        skill_curator_min_success_rate: 0.5,
      },
    }).processOne();

    expect(called).toBe(true);
    expect(w.budget.status().used).toBe(15);
  });

  it('scheduler /search при исчерпанном бюджете → search без LLM', async () => {
    const w = makeWorld('search-fb');
    w.budget.recordUsage({ promptTokens: 900, completionTokens: 0, estimated: false });

    const { EpisodeStore } = await import('../../src/memory/episodes.ts');
    const memoryDb = openDb(join(tmp, 'search-fb-memory.db'));
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    const episodes = new EpisodeStore(memoryDb, { now: () => NOW });
    episodes.append('tg:1', 'owner', 'budget meeting notes', 'owner');

    w.queues.publish(
      'inbound',
      JSON.stringify({
        text: '/search budget',
        session_id: 'scheduler:search',
      }),
      'scheduler',
    );

    const orch = new Orchestrator(
      w.queues,
      w.audit,
      {
        complete: () => Promise.reject(new Error('no llm')),
      },
      new PendingStore(w.queueDb),
      {
        budget: w.budget,
        episodes,
        ownerNotifySessionId: 'tg:99',
      },
    );

    await orch.processOne();

    const out = w.queues.claim('outbound', 'p');
    expect(out).toBeDefined();
    const { text } = JSON.parse(out!.payload) as { text: string };
    expect(text.toLowerCase()).toContain('budget');
    expect(auditActions(w.auditDb)).not.toContain('llm.completed');
  });
});
