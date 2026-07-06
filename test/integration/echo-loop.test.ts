/**
 * E2E Sprint 1: эхо-петля на реальных queue.db/audit.db (во временной директории)
 * с фейковым LLM. Проверяет DoD: сообщение проходит inbound → LLM → outbound,
 * каждое действие в audit log, цепочка верифицируется, ключ не течёт в audit.
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
import { LlmError, OpenAiCompatClient } from '../../src/llm/client.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-echo-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const FAKE_KEY = 'sk-super-secret-value';

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
        usage: { promptTokens: 12, completionTokens: 4, estimated: false },
      });
    },
  };
}

function auditRows(db: Database.Database): { action: string; payload_hash: string }[] {
  return db.prepare('SELECT action, payload_hash FROM audit_log ORDER BY id').all() as {
    action: string;
    payload_hash: string;
  }[];
}

describe('echo loop (e2e, DoD Sprint 1)', () => {
  it('сообщение проходит петлю: inbound → LLM → outbound; audit полный и верифицируемый', async () => {
    const w = makeWorld('happy');
    const orchestrator = makeOrchestrator(w, fakeLlm(), { worker: 'w1' });

    w.queues.publish('inbound', JSON.stringify({ text: 'привет', session_id: 's1' }), 'owner');
    expect(await orchestrator.processOne()).toBe(true);

    // Ответ в outbound с тем же session_id
    const out = w.queues.claim('outbound', 'adapter');
    expect(out).toBeDefined();
    expect(JSON.parse(out!.payload)).toEqual({ text: 'echo: привет', session_id: 's1' });

    // Inbound пуст (ack)
    w.now.value += 100_000;
    expect(w.queues.claim('inbound', 'w1')).toBeUndefined();

    // Audit: полная последовательность действий, цепочка цела
    expect(auditRows(w.auditDb).map((r) => r.action)).toEqual([
      'message.claimed',
      'llm.invoke',
      'memory.read',
      'llm.completed',
      'message.send',
      'message.processed',
    ]);
    expect(w.audit.verifyChain()).toEqual({ ok: true, entries: 6 });

    // Пустая очередь — processOne возвращает false
    expect(await orchestrator.processOne()).toBe(false);
  });

  it('ошибка LLM: сообщение возвращается по timeout, после max_attempts уходит в dead', async () => {
    const w = makeWorld('failing');
    const failingLlm: LlmClient = {
      complete: () => Promise.reject(new LlmError('provider returned 503', true)),
    };
    const orchestrator = makeOrchestrator(w, failingLlm, { worker: 'w1' });

    w.queues.publish('inbound', JSON.stringify({ text: 'hi', session_id: 's2' }), 'owner');

    // max_attempts = 5 (DDL default): 5 неудачных обработок + 1 клейм, фиксирующий dead
    for (let i = 0; i < 6; i++) {
      w.now.value += 31_000;
      expect(await orchestrator.processOne()).toBe(true);
    }

    // Сообщение мертво: больше не выдаётся
    w.now.value += 31_000;
    expect(await orchestrator.processOne()).toBe(false);

    // 5 циклов (claimed + failed) + финальная запись dead = 11
    const actions = auditRows(w.auditDb).map((r) => r.action);
    expect(actions.filter((a) => a === 'message.claimed')).toHaveLength(5);
    expect(actions.filter((a) => a === 'llm.invoke')).toHaveLength(5);
    expect(actions.filter((a) => a === 'memory.read')).toHaveLength(5);
    expect(actions.filter((a) => a === 'llm.failed')).toHaveLength(5);
    expect(actions.at(-1)).toBe('message.dead');
    expect(w.audit.verifyChain()).toEqual({ ok: true, entries: 21 });

    // Outbound пуст — ответ не публиковался
    expect(w.queues.claim('outbound', 'adapter')).toBeUndefined();
  });

  it('малформленный payload уходит в dead без вызова LLM и без краша петли', async () => {
    const w = makeWorld('malformed');
    let llmCalls = 0;
    const countingLlm: LlmClient = {
      complete: () => {
        llmCalls++;
        return Promise.reject(new Error('must not be called'));
      },
    };
    const orchestrator = makeOrchestrator(w, countingLlm, { worker: 'w1' });

    w.queues.publish('inbound', 'не json', 'owner');
    w.queues.publish('inbound', JSON.stringify({ wrong: 'shape' }), 'owner');

    expect(await orchestrator.processOne()).toBe(true);
    expect(await orchestrator.processOne()).toBe(true);

    expect(llmCalls).toBe(0);
    expect(auditRows(w.auditDb).map((r) => r.action)).toEqual([
      'message.malformed',
      'message.malformed',
    ]);
  });

  it('секрет LLM не попадает в audit log (реальный клиент, мок-fetch)', async () => {
    const w = makeWorld('secrets');
    process.env.AEGIS_E2E_LLM_KEY = FAKE_KEY;
    try {
      const client = new OpenAiCompatClient(
        {
          base_url: 'http://llm.test/v1',
          model: 'm',
          key_ref: 'AEGIS_E2E_LLM_KEY',
          max_tokens: 64,
        },
        {
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  choices: [{ message: { role: 'assistant', content: 'echo: check' } }],
                  usage: { prompt_tokens: 3, completion_tokens: 2 },
                }),
                { status: 200 },
              ),
            ),
        },
      );
      const orchestrator = makeOrchestrator(w, client, { worker: 'w1' });
      w.queues.publish('inbound', JSON.stringify({ text: 'check', session_id: 's3' }), 'owner');
      await orchestrator.processOne();
    } finally {
      delete process.env.AEGIS_E2E_LLM_KEY;
    }

    expect(w.audit.verifyChain()).toEqual({ ok: true, entries: 6 });
    const allColumns = w.auditDb
      .prepare('SELECT * FROM audit_log')
      .all()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(allColumns).not.toContain(FAKE_KEY);
  });

  it('graceful shutdown: run() выходит по AbortSignal', async () => {
    const w = makeWorld('shutdown');
    const orchestrator = makeOrchestrator(w, fakeLlm(), {
      worker: 'w1',
      pollMs: 5,
    });

    const ac = new AbortController();
    const done = orchestrator.run(ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(done).resolves.toBeUndefined();
  });
});
