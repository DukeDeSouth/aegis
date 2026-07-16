/**
 * E2E Sprint 26 / F10: BrokerHttpEmailFetcher → quarantine → P.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EmailInputAdapter } from '../../src/host/adapter/email/adapter.ts';
import { BrokerHttpEmailFetcher } from '../../src/host/adapter/email/fetcher.ts';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QuarantineProcessor } from '../../src/host/quarantine/processor.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-imap-email-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function startFakeBridge(
  messages: { uid: number; from: string; subject: string; body: string }[],
): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/messages') {
        res.writeHead(404);
        res.end();
        return;
      }
      const since = Number(url.searchParams.get('since_uid') ?? '0');
      const batch = messages.filter((m) => m.uid > since);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(batch));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => srv.close(),
      });
    });
  });
}

describe('imap email loop (F10)', () => {
  it('bridge HTTP → quarantine → P summary', async () => {
    const bridge = await startFakeBridge([
      { uid: 7, from: 'shop@example', subject: 'order', body: 'Your order shipped today.' },
    ]);

    const queueDb = openDb(join(tmp, 'imap-q.db'));
    const auditDb = openDb(join(tmp, 'imap-a.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0002-queue.sql'), 2);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(queueDb, migration('0008-queue.sql'), 8);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const fetcher = new BrokerHttpEmailFetcher(bridge.base);

    const emailAdapter = new EmailInputAdapter(fetcher, queues, audit, state, {
      pollMs: 5,
      sessionId: 'email:inbox',
    });

    const ac = new AbortController();
    const emailRun = emailAdapter.run(ac.signal);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await emailRun;

    expect(state.getEmailLastUid()).toBe(7);

    const inbound = queues.claim('inbound', 't');
    expect(inbound?.provenance).toBe('quarantine');
    const payload = JSON.parse(inbound!.payload) as { kind: string; source: string; body: string };
    expect(payload.source).toBe('email');
    expect(payload.body).toContain('shipped');

    const qLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'email about shipping' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const pLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'Summary: order shipped.' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const pending = new PendingStore(queueDb);
    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      quarantine: new QuarantineProcessor(qLlm),
    });
    queues.publish('inbound', inbound!.payload, 'quarantine');
    await orch.processOne();

    const out = queues.claim('outbound', 'probe');
    expect(out).toBeDefined();
    expect((JSON.parse(out!.payload) as { text: string }).text).toContain('Summary');

    bridge.close();
  });
});
