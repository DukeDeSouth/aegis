/**
 * E2E Sprint 5: память в петле оркестратора.
 * DoD: /search без LLM; /remember; inject corroborated; episode append.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import type { OrchestratorOptions } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-memory-'));
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
  memoryDb: Database.Database;
  episodes: EpisodeStore;
  knowledge: KnowledgeStore;
  now: { value: number };
}

function makeWorld(name: string): World {
  const now = { value: NOW };
  const queueDb = openDb(join(tmp, `${name}-queue.db`));
  const auditDb = openDb(join(tmp, `${name}-audit.db`));
  const memoryDb = openDb(join(tmp, `${name}-memory.db`));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  applyMigration(memoryDb, migration('0001-memory.sql'), 1);
  const episodes = new EpisodeStore(memoryDb, { now: () => now.value });
  const knowledge = new KnowledgeStore(memoryDb, { now: () => now.value });
  return {
    queues: new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => now.value }),
    audit: new AuditLog(auditDb, { now: () => now.value }),
    auditDb,
    queueDb,
    memoryDb,
    episodes,
    knowledge,
    now,
  };
}

function makeOrchestrator(w: World, llm: LlmClient, opts: OrchestratorOptions = {}): Orchestrator {
  const pending = new PendingStore(w.queueDb, { now: () => w.now.value });
  return new Orchestrator(w.queues, w.audit, llm, pending, {
    episodes: w.episodes,
    knowledge: w.knowledge,
    ...opts,
  });
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('memory loop (e2e, DoD Sprint 5)', () => {
  it('/search возвращает FTS-результаты без llm.invoke', async () => {
    const w = makeWorld('search');
    w.episodes.append('tg:10', 'owner', 'встреча с бухгалтером в четверг', 'owner');
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: '/search бухгалтером', session_id: 'tg:10' }),
      'owner',
    );
    const orch = makeOrchestrator(w, {
      complete: () => Promise.reject(new Error('LLM must not run')),
    });
    expect(await orch.processOne()).toBe(true);

    const out = w.queues.claim('outbound', 'probe');
    expect(out).toBeDefined();
    const outPayload = JSON.parse(out!.payload) as { text: string };
    expect(outPayload.text).toContain('бухгалтером');
    expect(auditActions(w.auditDb)).not.toContain('llm.invoke');
    expect(auditActions(w.auditDb)).toContain('memory.read');
  });

  it('quarantine /search → deny, без outbound', async () => {
    const w = makeWorld('q-search');
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: '/search test', session_id: 'tg:10' }),
      'quarantine',
    );
    const orch = makeOrchestrator(w, {
      complete: () => Promise.reject(new Error('no llm')),
    });
    expect(await orch.processOne()).toBe(true);
    expect(w.queues.claim('outbound', 'probe')).toBeUndefined();
  });

  it('/remember сохраняет unverified knowledge', async () => {
    const w = makeWorld('remember');
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: '/remember API | https://api.example.com', session_id: 'tg:10' }),
      'owner',
    );
    const orch = makeOrchestrator(w, {
      complete: () => Promise.reject(new Error('no llm')),
    });
    expect(await orch.processOne()).toBe(true);
    expect(w.knowledge.listForInjection()).toHaveLength(0);
    const row = w.memoryDb.prepare('SELECT title FROM knowledge').get() as { title: string };
    expect(row.title).toBe('API');
  });

  it('corroborated knowledge инжектируется в system prompt', async () => {
    const w = makeWorld('inject');
    const id = w.knowledge.insert({ title: 'Fact', body: 'secret-value', provenance: 'owner' });
    w.memoryDb
      .prepare(
        `INSERT INTO evidence (knowledge_id, evidence_type, summary, created_at)
         VALUES (?, 'test_pass', 'ok', ?)`,
      )
      .run(id, NOW);
    w.memoryDb
      .prepare(`UPDATE knowledge SET epistemic_status = 'corroborated' WHERE id = ?`)
      .run(id);

    let capturedSystem = '';
    const llm: LlmClient = {
      complete(req): Promise<LlmResult> {
        capturedSystem = req.messages.find((m) => m.role === 'system')?.content ?? '';
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    w.queues.publish('inbound', JSON.stringify({ text: 'hi', session_id: 'tg:10' }), 'owner');
    await makeOrchestrator(w, llm).processOne();
    expect(capturedSystem).toContain('Fact');
    expect(capturedSystem).toContain('secret-value');
  });

  it('диалог записывает owner и assistant в episodes', async () => {
    const w = makeWorld('append');
    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'reply' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    w.queues.publish('inbound', JSON.stringify({ text: 'hello', session_id: 'tg:10' }), 'owner');
    await makeOrchestrator(w, llm).processOne();
    const rows = w.episodes.listBySession('tg:10');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'owner']);
  });
});
