/**
 * E2E Sprint 13 / F3: стартовые навыки — /digest, /remind, /summarize, /status.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QuarantineProcessor } from '../../src/host/quarantine/processor.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { ReminderStore } from '../../src/host/scheduler/reminders.ts';
import { ScheduleRunner } from '../../src/host/scheduler/scheduler.ts';
import { StaticWebFetcher } from '../../src/host/web/fetcher.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { WebCacheStore } from '../../src/memory/web-cache.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';

const rootTmp = mkdtempSync(join(tmpdir(), 'aegis-starter-skills-'));
afterAll(() => rmSync(rootTmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;
const PAGE = 'https://example.com/news';
const BODY = 'Breaking: tests pass.';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function setupSkillsDir(): string {
  const dir = join(rootTmp, `skills-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const name of ['web-digest', 'reminders', 'memory-search', 'agent-status']) {
    cpSync(join(process.cwd(), 'skills', name), join(dir, name), { recursive: true });
  }
  writeFileSync(
    join(dir, 'web-digest', 'SKILL.md'),
    readFileSync(join(dir, 'web-digest', 'SKILL.md'), 'utf8').replace(
      'https://example.com/news',
      PAGE,
    ),
  );
  return dir;
}

function makeWorld(skillsDir: string) {
  const queueDb = openDb(join(rootTmp, `q-${Date.now()}.db`));
  const auditDb = openDb(join(rootTmp, `a-${Date.now()}.db`));
  const memoryDb = openDb(join(rootTmp, `m-${Date.now()}.db`));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(queueDb, migration('0005-queue.sql'), 5);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  applyMigration(memoryDb, migration('0001-memory.sql'), 1);
  applyMigration(memoryDb, migration('0002-memory.sql'), 2);

  const episodes = new EpisodeStore(memoryDb, { now: () => NOW });
  episodes.append('tg:1', 'owner', 'project alpha launch notes', 'owner');
  const registry = new SkillRegistry(skillsDir);
  const reminders = new ReminderStore(queueDb, { now: () => NOW });
  const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
  const audit = new AuditLog(auditDb, { now: () => NOW });
  const pending = new PendingStore(queueDb, { now: () => NOW });
  const webCache = new WebCacheStore(memoryDb);

  const pLlm: LlmClient = {
    complete(req): Promise<LlmResult> {
      const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
      if (user.includes('Summarize')) {
        return Promise.resolve({
          message: { role: 'assistant', content: 'Summary: alpha launch mentioned.' },
          usage: { promptTokens: 10, completionTokens: 5 },
        });
      }
      return Promise.resolve({
        message: { role: 'assistant', content: 'Digest summary.' },
        usage: { promptTokens: 10, completionTokens: 5 },
      });
    },
  };
  const qLlm: LlmClient = {
    complete(): Promise<LlmResult> {
      return Promise.resolve({
        message: { role: 'assistant', content: 'Safe digest excerpt.' },
        usage: { promptTokens: 5, completionTokens: 3 },
      });
    },
  };

  const orch = new Orchestrator(queues, audit, pLlm, pending, {
    episodes,
    skills: registry,
    reminders,
    quarantine: new QuarantineProcessor(qLlm, { maxTokens: 512 }),
    webFetcher: new StaticWebFetcher({ [PAGE]: BODY }),
    webCache,
    getReuseMetrics: () => ({ injectable: 0, used: 0, reuseRate: null }),
  });

  const scheduler = new ScheduleRunner(queues, queueDb, audit, {
    schedules: [],
    reminders,
    now: () => NOW,
  });

  return { queues, orch, scheduler, reminders, session: 'tg:1' };
}

function drainOutbound(queues: QueueStore): string[] {
  const out: string[] = [];
  for (;;) {
    const msg = queues.claim('outbound', 'test');
    if (!msg) break;
    const p = JSON.parse(msg.payload) as { text: string };
    out.push(p.text);
    queues.ack(msg.id);
  }
  return out;
}

describe('starter skills loop (F3)', () => {
  it('/digest fetches sources and quarantines', async () => {
    const w = makeWorld(setupSkillsDir());
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: '/digest', session_id: w.session }),
      'owner',
    );
    await w.orch.processOne();
    await w.orch.processOne();
    const texts = drainOutbound(w.queues);
    expect(texts.some((t) => t.includes('Safe digest') || t.includes('Digest summary'))).toBe(
      true,
    );
  });

  it('/remind + scheduler tick delivers outbound', async () => {
    const w = makeWorld(setupSkillsDir());
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: '/remind 08:00 tea time', session_id: w.session }),
      'owner',
    );
    await w.orch.processOne();
    expect(drainOutbound(w.queues)[0]).toContain('Reminder');

    w.reminders.add(NOW - 1000, 'tea time', w.session);
    w.scheduler.tick();
    expect(drainOutbound(w.queues)).toContain('⏰ tea time');
  });

  it('/summarize uses memory + LLM', async () => {
    const w = makeWorld(setupSkillsDir());
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: '/summarize alpha', session_id: w.session }),
      'owner',
    );
    await w.orch.processOne();
    expect(drainOutbound(w.queues)).toContain('Summary: alpha launch mentioned.');
  });

  it('/status reports skills count', async () => {
    const w = makeWorld(setupSkillsDir());
    w.queues.publish(
      'inbound',
      JSON.stringify({ text: '/status', session_id: w.session }),
      'owner',
    );
    await w.orch.processOne();
    const text = drainOutbound(w.queues).join('\n');
    expect(text).toContain('Skills loaded: 4');
  });
});
