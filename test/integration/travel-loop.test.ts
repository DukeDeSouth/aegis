/**
 * E2E Sprint 36 / C20: /travel-ingest → /travel-brief with optional flight.
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

const tmp = mkdtempSync(join(tmpdir(), 'aegis-travel-loop-'));
afterAll(() => {
  clearMcpActions();
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const SESSION = 'tg:42';

const SAMPLE_BODIES = `---MSG t1---
From: hotel@booking.com
Date: Wed, 16 Jul 2026
Subject: Hotel confirmation Grand Plaza

Check-in: 18 Jul 2026
Flight SU123
`;

class MockTravelMcp implements McpRunner {
  async call(_server: McpServerConfig, tool: string): Promise<string> {
    if (tool === 'gmail_travel_fetch') return SAMPLE_BODIES;
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

describe('travel loop (C20)', () => {
  it('/travel-ingest then /travel-brief SU123 builds brief', async () => {
    registerMcpTool('google', 'gmail_travel_fetch', 'read-only');
    const queueDb = openDb(join(tmp, 't-queue.db'));
    const auditDb = openDb(join(tmp, 't-audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });

    const journal: string[] = [];
    let flightFetched = false;
    const fetcher = new StaticWebFetcher(
      {},
      {},
      undefined,
      undefined,
      {
        ingest: (bodies) => {
          expect(bodies).toContain('Grand Plaza');
          journal.push(
            '{"kind":"hotel","subject":"Hotel confirmation Grand Plaza","flight_iata":"SU123","source_msg_id":"t1"}',
          );
          return 'TRAVEL_OK: added 1 entries';
        },
        brief: (flightIata) => {
          if (flightIata === 'SU123') flightFetched = true;
          return `TRAVEL_BRIEF: ${journal.length} bookings, brief at workspace/travel/brief.md`;
        },
      },
    );

    const googleServer: McpServerConfig = {
      name: 'google',
      transport: 'stdio',
      command: ['node', 'noop'],
      tools: [{ name: 'gmail_travel_fetch', action_class: 'read-only' }],
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
      mcpRunner: new MockTravelMcp(),
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    queues.publish('inbound', JSON.stringify({ text: '/travel-ingest', session_id: SESSION }), 'owner');
    await orch.processOne();
    const ingestOut = drainOutbound(queues);
    expect(ingestOut.some((t) => t.includes('TRAVEL_OK: added 1'))).toBe(true);

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/travel-brief SU123', session_id: SESSION }),
      'owner',
    );
    await orch.processOne();
    const briefOut = drainOutbound(queues);
    expect(flightFetched).toBe(true);
    expect(briefOut.some((t) => t.includes('TRAVEL_BRIEF: 1 bookings'))).toBe(true);
  });
});
