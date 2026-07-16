/**
 * E2E Sprint 28 / C9: /finance-ingest → /finance-report monthly total.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { clearMcpActions, registerMcpTool } from '../../src/host/gate/mcp-actions.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { StaticWebFetcher } from '../../src/host/web/fetcher.ts';
import type { McpRunner } from '../../src/mcp/runner.ts';
import type { McpServerConfig } from '../../src/config/schema.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-finance-loop-'));
afterAll(() => {
  clearMcpActions();
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const SESSION = 'tg:42';
const MONTH = '2026-07';

const SAMPLE_BODIES = `---MSG m1---
From: shop@example.com
Date: Tue, 1 Jul 2026
Subject: Receipt order #1

Total: 45.99 USD
`;

class MockFinanceMcp implements McpRunner {
  async call(_server: McpServerConfig, tool: string): Promise<string> {
    if (tool === 'gmail_finance_fetch') return SAMPLE_BODIES;
    throw new Error(`unexpected tool ${tool}`);
  }
}

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
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

describe('finance loop (C9)', () => {
  it('/finance-ingest then /finance-report returns total', async () => {
    registerMcpTool('google', 'gmail_finance_fetch', 'read-only');
    const queueDb = openDb(join(tmp, 'f-queue.db'));
    const auditDb = openDb(join(tmp, 'f-audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });

    const journal: string[] = [];
    const fetcher = new StaticWebFetcher({}, {}, {
      ingest: (bodies) => {
        expect(bodies).toContain('45.99');
        journal.push('{"date":"2026-07-01","amount":45.99,"currency":"USD","merchant":"Receipt","source_msg_id":"m1","raw_snippet":"x"}');
        return 'FINANCE_OK: added 1 entries';
      },
      report: (month) => {
        const m = month ?? MONTH;
        const total = journal.reduce((s, line) => {
          const amt = Number(JSON.parse(line).amount);
          return s + amt;
        }, 0);
        return `FINANCE_REPORT: ${m}: ${journal.length} entries, total ${total.toFixed(2)}`;
      },
    });

    const googleServer: McpServerConfig = {
      name: 'google',
      transport: 'stdio',
      command: ['node', 'noop'],
      tools: [{ name: 'gmail_finance_fetch', action_class: 'read-only' }],
    };

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
      mcpServers: [googleServer],
      mcpRunner: new MockFinanceMcp(),
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    queues.publish('inbound', JSON.stringify({ text: '/finance-ingest', session_id: SESSION }), 'owner');
    await orch.processOne();
    const ingestOut = drainOutbound(queues);
    expect(ingestOut.some((t) => t.includes('FINANCE_OK: added 1'))).toBe(true);

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/finance-report ${MONTH}`, session_id: SESSION }),
      'owner',
    );
    await orch.processOne();
    const reportOut = drainOutbound(queues);
    expect(reportOut.some((t) => t.includes('FINANCE_REPORT: 2026-07: 1 entries, total 45.99'))).toBe(
      true,
    );
  });
});
