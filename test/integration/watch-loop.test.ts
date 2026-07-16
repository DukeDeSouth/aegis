/**
 * E2E Sprint 26 / C8: /watch baseline → cron tick → WATCH_CHANGED notify.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { ScheduleRunner } from '../../src/host/scheduler/scheduler.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { StaticWebFetcher } from '../../src/host/web/fetcher.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-watch-loop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PAGE_URL = 'https://shop.example/item';
/** Время, кратное 30 минутам для cron. */
const NOW = 1_800_000_000_000;
const SESSION = 'tg:42';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

function drainOutbound(queues: QueueStore): string[] {
  const out: string[] = [];
  for (;;) {
    const msg = queues.claim('outbound', 'test');
    if (!msg) break;
    out.push((JSON.parse(msg.payload) as { text: string }).text);
    queues.ack(msg.id);
  }
  return out;
}

describe('watch loop (C8)', () => {
  it('/watch baseline silent; cron /watch → WATCH_CHANGED outbound', async () => {
    const queueDb = openDb(join(tmp, 'w-queue.db'));
    const auditDb = openDb(join(tmp, 'w-audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(queueDb, migration('0004-budget.sql'), 4);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const fetcher = new StaticWebFetcher(
      { [PAGE_URL]: 'price 19.99' },
      { [PAGE_URL]: ['price 19.99', 'price 14.99'] },
    );

    const pLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      webFetcher: fetcher,
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    const scheduler = new ScheduleRunner(queues, queueDb, audit, {
      schedules: [
        {
          id: 'price-check',
          cron: '*/30',
          text: `/watch ${PAGE_URL}`,
          session_id: SESSION,
        },
      ],
      now: () => NOW,
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/watch ${PAGE_URL}`, session_id: SESSION }),
      'owner',
    );
    await orch.processOne();
    expect(drainOutbound(queues)).toEqual([]);
    expect(auditActions(auditDb)).toContain('watch.baseline');

    scheduler.tick();
    await orch.processOne();

    const texts = drainOutbound(queues);
    expect(texts.some((t) => t.includes('WATCH_CHANGED'))).toBe(true);
    expect(auditActions(auditDb)).toContain('watch.changed');
  });
});
