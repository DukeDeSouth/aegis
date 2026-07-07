/**
 * E2E Sprint 11: история диалога + active recall в P-LLM.
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
import type { LlmClient, LlmMessage, LlmResult } from '../../src/llm/types.ts';
import { DEFAULT_MEMORY_CONTEXT } from '../../src/memory/context.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-ctx-loop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function makeWorld(name: string): {
  queues: QueueStore;
  audit: AuditLog;
  queueDb: Database.Database;
  episodes: EpisodeStore;
  now: { value: number };
} {
  const now = { value: NOW };
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
    queueDb,
    episodes: new EpisodeStore(memoryDb, { now: () => now.value }),
    now,
  };
}

function makeOrchestrator(
  w: ReturnType<typeof makeWorld>,
  llm: LlmClient,
  opts: OrchestratorOptions = {},
): Orchestrator {
  const pending = new PendingStore(w.queueDb, { now: () => w.now.value });
  return new Orchestrator(w.queues, w.audit, llm, pending, {
    episodes: w.episodes,
    memoryContext: DEFAULT_MEMORY_CONTEXT,
    ...opts,
  });
}

describe('context loop (e2e, Sprint 11)', () => {
  it('план из сообщения №1 доступен в ходе №5 через historyMessages', async () => {
    const w = makeWorld('plan');
    const session = 'tg:42';
    let lastMessages: LlmMessage[] = [];

    const llm: LlmClient = {
      complete(req): Promise<LlmResult> {
        lastMessages = req.messages;
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const orch = makeOrchestrator(w, llm);

    w.queues.publish(
      'inbound',
      JSON.stringify({ text: 'Наш план: сначала API, потом UI', session_id: session }),
      'owner',
    );
    await orch.processOne();

    for (let i = 0; i < 3; i++) {
      w.queues.publish(
        'inbound',
        JSON.stringify({ text: `промежуточное ${i}`, session_id: session }),
        'owner',
      );
      await orch.processOne();
    }

    w.queues.publish(
      'inbound',
      JSON.stringify({ text: 'Что мы решили делать первым?', session_id: session }),
      'owner',
    );
    await orch.processOne();

    expect(lastMessages.length).toBeGreaterThan(2);
    expect(
      lastMessages.some((m) => m.role === 'user' && m.content.includes('Наш план: сначала API')),
    ).toBe(true);
  });

  it('active recall без отдельного llm.invoke на поиск', async () => {
    const w = makeWorld('recall');
    w.episodes.append('tg:old', 'owner', 'договорились с бухгалтером на пятницу', 'owner');

    const actions: string[] = [];
    const llm: LlmClient = {
      complete(req): Promise<LlmResult> {
        const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
        expect(sys).toContain('бухгалтером');
        return Promise.resolve({
          message: { role: 'assistant', content: 'напомнил' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const orch = makeOrchestrator(w, llm);
    const origAppend = w.audit.append.bind(w.audit);
    w.audit.append = (entry) => {
      actions.push(entry.action);
      origAppend(entry);
    };

    w.queues.publish(
      'inbound',
      JSON.stringify({ text: 'бухгалтером встреча', session_id: 'tg:new' }),
      'owner',
    );
    await orch.processOne();

    const llmInvokes = actions.filter((a) => a === 'llm.invoke').length;
    expect(llmInvokes).toBe(1);
  });
});
