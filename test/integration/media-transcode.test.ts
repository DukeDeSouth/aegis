/**
 * E2E Sprint 33 / C14: /media-transcode → 3 versions via sandbox mock.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { StaticWebFetcher } from '../../src/host/web/fetcher.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-media-loop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SESSION = 'tg:42';
const CLIP = 'media/in/clip.mp4';
const MEDIA_OK = `MEDIA_OK: media/out/clip/youtube_16x9.mp4 media/out/clip/tiktok_9x16.mp4 media/out/clip/shorts_60s.mp4`;

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

function stubLlm(): LlmClient {
  return {
    complete(): Promise<LlmResult> {
      return Promise.resolve({
        message: { role: 'assistant', content: 'ok' },
        usage: { promptTokens: 1, completionTokens: 1, estimated: false },
      });
    },
  };
}

describe('media transcode loop (C14)', () => {
  it('/media-transcode → MEDIA_OK outbound, audit media.transcoded', async () => {
    const queueDb = openDb(join(tmp, 'm-queue.db'));
    const auditDb = openDb(join(tmp, 'm-audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(queueDb, migration('0004-budget.sql'), 4);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb);
    const audit = new AuditLog(auditDb);
    const pending = new PendingStore(queueDb);
    const fetcher = new StaticWebFetcher(
      {},
      {},
      undefined,
      {
        transcode: (path, subs) => {
          expect(path).toBe(CLIP);
          expect(subs).toBe(false);
          return MEDIA_OK;
        },
      },
    );

    const orch = new Orchestrator(queues, audit, stubLlm(), pending, {
      webFetcher: fetcher,
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/media-transcode ${CLIP}`, session_id: SESSION }),
      'owner',
    );

    expect(await orch.processOne()).toBe(true);
    const replies = drainOutbound(queues);
    expect(replies[0]).toBe(MEDIA_OK);
    expect(auditActions(auditDb)).toContain('media.transcoded');
  });

  it('/media-transcode --subs appends SRT block', async () => {
    const queueDb = openDb(join(tmp, 'm2-queue.db'));
    const auditDb = openDb(join(tmp, 'm2-audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb);
    const audit = new AuditLog(auditDb);
    const pending = new PendingStore(queueDb);
    const fetcher = new StaticWebFetcher(
      {},
      {},
      undefined,
      {
        transcode: (_path, subs) => {
          expect(subs).toBe(true);
          return `${MEDIA_OK}\nSRT:\nhello from media mock`;
        },
      },
    );

    const orch = new Orchestrator(queues, audit, stubLlm(), pending, {
      webFetcher: fetcher,
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/media-transcode ${CLIP} --subs`, session_id: SESSION }),
      'owner',
    );

    expect(await orch.processOne()).toBe(true);
    const replies = drainOutbound(queues);
    expect(replies[0]).toContain('SRT:');
    expect(replies[0]).toContain('hello from media mock');
  });
});
