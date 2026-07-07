/**
 * E2E Sprint 12 / F2: /fetch → quarantine Q→P.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QuarantineProcessor } from '../../src/host/quarantine/processor.ts';
import { StaticWebFetcher } from '../../src/host/web/fetcher.ts';
import type { WebFetcher } from '../../src/host/web/fetcher.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { WebCacheStore } from '../../src/memory/web-cache.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-fetch-loop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;
const PAGE_URL = 'https://example.com/article';
const PAGE_BODY = 'Article says: quarterly results improved.';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('fetch loop (e2e, F2)', () => {
  it('/fetch url → Q→P с выжимкой, без sandbox.run', async () => {
    const queueDb = openDb(join(tmp, 'f-queue.db'));
    const auditDb = openDb(join(tmp, 'f-audit.db'));
    const memoryDb = openDb(join(tmp, 'f-memory.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(memoryDb, migration('0002-memory.sql'), 2);

    const qLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'Page discusses quarterly results.' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    let pSystem = '';
    const pLlm: LlmClient = {
      complete(req): Promise<LlmResult> {
        pSystem = req.messages.find((m) => m.role === 'system')?.content ?? '';
        return Promise.resolve({
          message: { role: 'assistant', content: 'Summary: results improved.' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const webCache = new WebCacheStore(memoryDb);
    const fetcher = new StaticWebFetcher({ [PAGE_URL]: PAGE_BODY });

    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      quarantine: new QuarantineProcessor(qLlm),
      webFetcher: fetcher,
      webCache,
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/fetch ${PAGE_URL}`, session_id: 'tg:10' }),
      'owner',
    );

    expect(await orch.processOne()).toBe(true);

    const actions = auditActions(auditDb);
    expect(actions).toContain('web.fetch');
    expect(actions).toContain('web.fetch.completed');
    expect(actions).toContain('quarantine.q_llm');
    expect(actions).toContain('quarantine.completed');
    expect(actions).not.toContain('sandbox.run');

    expect(pSystem).toContain('Untrusted content');
    expect(pSystem).toContain('quarterly');

    const out = queues.claim('outbound', 'probe');
    expect(out).toBeDefined();
    expect((JSON.parse(out!.payload) as { text: string }).text).toContain('Summary');
  });

  it('второй /fetch использует cache', async () => {
    const queueDb = openDb(join(tmp, 'f2-queue.db'));
    const auditDb = openDb(join(tmp, 'f2-audit.db'));
    const memoryDb = openDb(join(tmp, 'f2-memory.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(memoryDb, migration('0002-memory.sql'), 2);

    let fetchCalls = 0;
    const fetcher: WebFetcher = {
      async fetch() {
        fetchCalls++;
        return PAGE_BODY;
      },
    };

    const qLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const pLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const queues = new QueueStore(queueDb, { now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      quarantine: new QuarantineProcessor(qLlm),
      webFetcher: fetcher,
      webCache: new WebCacheStore(memoryDb),
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    const cmd = JSON.stringify({ text: `/fetch ${PAGE_URL}`, session_id: 'tg:11' });
    queues.publish('inbound', cmd, 'owner');
    await orch.processOne();
    queues.publish('inbound', cmd, 'owner');
    await orch.processOne();

    expect(fetchCalls).toBe(1);
    expect(auditActions(auditDb).filter((a) => a === 'web.fetch.cache_hit').length).toBe(1);
  });
});
