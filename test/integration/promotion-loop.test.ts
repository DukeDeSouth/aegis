/**
 * E2E Sprint 6: promotion, auto-corroborate, orchestrator commands.
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
import { CurationRunner } from '../../src/memory/curation.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';
import { KnowledgeVerifier } from '../../src/memory/verifier.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-promo-loop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

interface World {
  queues: QueueStore;
  audit: AuditLog;
  queueDb: Database.Database;
  memoryDb: Database.Database;
  memoryPath: string;
  episodes: EpisodeStore;
  knowledge: KnowledgeStore;
  promotion: PromotionGate;
  verifier: KnowledgeVerifier;
  curation: CurationRunner;
  now: { value: number };
}

function makeWorld(name: string): World {
  const now = { value: NOW };
  const queueDb = openDb(join(tmp, `${name}-queue.db`));
  const auditDb = openDb(join(tmp, `${name}-audit.db`));
  const memoryPath = join(tmp, `${name}-memory.db`);
  const memoryDb = openDb(memoryPath);
  const snapDir = join(tmp, `${name}-snaps`);
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  applyMigration(memoryDb, migration('0001-memory.sql'), 1);
  const knowledge = new KnowledgeStore(memoryDb, { now: () => now.value });
  const promotion = new PromotionGate(memoryDb, { now: () => now.value });
  const verifier = new KnowledgeVerifier(memoryDb, knowledge, { promotion });
  const snapshot = new MemorySnapshot(memoryDb, memoryPath, snapDir, { now: () => now.value });
  const curation = new CurationRunner(memoryDb, knowledge, promotion, snapshot, {
    now: () => now.value,
    decayDays: 90,
  });
  return {
    queues: new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => now.value }),
    audit: new AuditLog(auditDb, { now: () => now.value }),
    queueDb,
    memoryDb,
    memoryPath,
    episodes: new EpisodeStore(memoryDb, { now: () => now.value }),
    knowledge,
    promotion,
    verifier,
    curation,
    now,
  };
}

function makeOrchestrator(w: World, llm: LlmClient, opts: OrchestratorOptions = {}): Orchestrator {
  const pending = new PendingStore(w.queueDb, { now: () => w.now.value });
  return new Orchestrator(w.queues, w.audit, llm, pending, {
    episodes: w.episodes,
    knowledge: w.knowledge,
    promotion: w.promotion,
    verifier: w.verifier,
    curation: w.curation,
    ...opts,
  });
}

describe('promotion loop (e2e, DoD Sprint 6)', () => {
  it('auto-corroborate → knowledge в system prompt', async () => {
    const w = makeWorld('auto');
    const id = w.knowledge.insert({ title: 'Rule', body: 'always be kind', provenance: 'owner' });
    expect(w.verifier.tryAutoCorroborate(id)).toBe(true);

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
    expect(capturedSystem).toContain('Rule');
    expect(capturedSystem).toContain('always be kind');
  });

  it('/corroborate <id> продвигает unverified → corroborated', async () => {
    const w = makeWorld('cmd-corr');
    const id = w.knowledge.insert({ title: 'API', body: 'https://x', provenance: 'owner' });
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: `/corroborate ${id}`, session_id: 'tg:10' }),
      'owner',
    );
    const orch = makeOrchestrator(w, {
      complete: () => Promise.reject(new Error('no llm')),
    });
    expect(await orch.processOne()).toBe(true);
    expect(w.knowledge.listForInjection()).toHaveLength(1);
    const out = w.queues.claim('outbound', 'probe');
    const outPayload = JSON.parse(out!.payload) as { text: string };
    expect(outPayload.text).toContain('corroborated');
  });

  it('quarantine не может /corroborate', async () => {
    const w = makeWorld('q-corr');
    const id = w.knowledge.insert({ title: 'X', body: 'Y', provenance: 'owner' });
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: `/corroborate ${id}`, session_id: 'tg:10' }),
      'quarantine',
    );
    await makeOrchestrator(w, {
      complete: () => Promise.reject(new Error('no llm')),
    }).processOne();
    expect(w.knowledge.listForInjection()).toHaveLength(0);
  });

  it('/curate создаёт snapshot и refute stale', async () => {
    const w = makeWorld('curate');
    w.memoryDb
      .prepare(
        `INSERT INTO knowledge (kind, title, body, provenance, stale_after, created_at, updated_at)
         VALUES ('fact', 'Stale', 'x', 'owner', ?, ?, ?)`,
      )
      .run(NOW - 1, NOW, NOW);
    w.queues.publish('inbound', JSON.stringify({ text: '/curate', session_id: 'tg:10' }), 'owner');
    await makeOrchestrator(w, {
      complete: () => Promise.reject(new Error('no llm')),
    }).processOne();
    expect(w.memoryDb.prepare('SELECT COUNT(*) c FROM snapshots').get()).toEqual({ c: 1 });
    expect(
      w.memoryDb.prepare(`SELECT epistemic_status s FROM knowledge WHERE title = 'Stale'`).get(),
    ).toEqual({ s: 'refuted' });
  });
});
