/**
 * E2E Sprint 4: gate engine в петле оркестратора.
 * DoD: owner → allow; quarantine → deny; irreversible → human-gate; gate unhealthy → deny.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { IRREVERSIBLE_TEST_CMD } from '../../src/host/gate/actions.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import type { OrchestratorOptions } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-gate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

interface World {
  queues: QueueStore;
  audit: AuditLog;
  auditDb: Database.Database;
  queueDb: Database.Database;
  memoryDb: Database.Database;
  now: { value: number };
}

function makeWorld(name: string): World {
  const now = { value: 1_750_000_000_000 };
  const queueDb = openDb(join(tmp, `${name}-queue.db`));
  const auditDb = openDb(join(tmp, `${name}-audit.db`));
  const memoryDb = openDb(join(tmp, `${name}-memory.db`));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  applyMigration(memoryDb, migration('0001-memory.sql'), 1);
  return {
    queues: new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => now.value }),
    audit: new AuditLog(auditDb, { now: () => now.value }),
    auditDb,
    queueDb,
    memoryDb,
    now,
  };
}

function makeOrchestrator(w: World, llm: LlmClient, opts: OrchestratorOptions = {}): Orchestrator {
  const pending = new PendingStore(w.queueDb, { now: () => w.now.value });
  const episodes = new EpisodeStore(w.memoryDb, { now: () => w.now.value });
  const knowledge = new KnowledgeStore(w.memoryDb, { now: () => w.now.value });
  return new Orchestrator(w.queues, w.audit, llm, pending, { episodes, knowledge, ...opts });
}

function fakeLlm(): LlmClient {
  return {
    complete(req): Promise<LlmResult> {
      const userText = req.messages.find((m) => m.role === 'user')?.content ?? '';
      return Promise.resolve({
        message: { role: 'assistant', content: `echo: ${userText}` },
        usage: { promptTokens: 1, completionTokens: 1, estimated: false },
      });
    },
  };
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('gate loop (e2e, DoD Sprint 4)', () => {
  it('owner → gate allow → LLM → outbound', async () => {
    const w = makeWorld('owner-allow');
    w.queues.publish('inbound', JSON.stringify({ text: 'hi', session_id: 'tg:10' }), 'owner');
    const orch = makeOrchestrator(w, fakeLlm());
    expect(await orch.processOne()).toBe(true);

    const out = w.queues.claim('outbound', 'probe');
    expect(out).toBeDefined();
    expect(JSON.parse(out!.payload)).toEqual({ text: 'echo: hi', session_id: 'tg:10' });
    expect(auditActions(w.auditDb)).toContain('llm.invoke');
    expect(auditActions(w.auditDb)).toContain('message.send');
    expect(w.audit.verifyChain()).toMatchObject({ ok: true });
  });

  it('quarantine inbound → deny llm.invoke, без outbound', async () => {
    const w = makeWorld('quarantine-deny');
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: 'poison', session_id: 'tg:10' }),
      'quarantine',
    );
    const orch = makeOrchestrator(w, fakeLlm());
    expect(await orch.processOne()).toBe(true);

    expect(w.queues.claim('outbound', 'probe')).toBeUndefined();
    const actions = auditActions(w.auditDb);
    expect(actions).toContain('llm.invoke');
    expect(actions).not.toContain('llm.completed');
    expect(actions).not.toContain('message.processed');
  });

  it('irreversible → confirm prompt → /approve → executed', async () => {
    const w = makeWorld('human-gate');
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: IRREVERSIBLE_TEST_CMD, session_id: 'tg:10' }),
      'owner',
    );
    const orch = makeOrchestrator(w, fakeLlm());
    expect(await orch.processOne()).toBe(true);

    const prompt = w.queues.claim('outbound', 'probe');
    expect(prompt).toBeDefined();
    const promptPayload = JSON.parse(prompt!.payload) as { text: string };
    const tokenMatch = /\/approve\s+(\S+)/.exec(promptPayload.text);
    expect(tokenMatch).toBeTruthy();
    const token = tokenMatch![1]!;

    w.queues.publish(
      'inbound',
      JSON.stringify({ kind: 'approved_action', token, session_id: 'tg:10' }),
      'owner',
    );
    expect(await orch.processOne()).toBe(true);

    const done = w.queues.claim('outbound', 'probe');
    expect(done).toBeDefined();
    const donePayload = JSON.parse(done!.payload) as { text: string };
    expect(donePayload.text).toBe('Irreversible action executed.');
    expect(auditActions(w.auditDb)).toContain('action.dangerous.executed');
  });

  it('gate unhealthy → deny всё (fail-closed)', async () => {
    const w = makeWorld('gate-down');
    w.queues.publish('inbound', JSON.stringify({ text: 'hi', session_id: 'tg:10' }), 'owner');
    const orch = makeOrchestrator(w, fakeLlm(), {
      gateDeps: { brokerAvailable: true, gateHealthy: false },
    });
    expect(await orch.processOne()).toBe(true);

    expect(w.queues.claim('outbound', 'probe')).toBeUndefined();
    const gateRows = w.auditDb
      .prepare(`SELECT decision FROM audit_log WHERE actor = 'gate' ORDER BY id`)
      .all() as { decision: string }[];
    expect(gateRows.some((r) => r.decision === 'deny')).toBe(true);
  });
});
