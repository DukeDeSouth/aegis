/**
 * E2E Sprint 28 / C7-CalDAV: MCP через gate, task_delete → /approve.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { clearMcpActions, registerMcpTool } from '../../src/host/gate/mcp-actions.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { StdioMcpRunner } from '../../src/mcp/runner.ts';
import type { McpServerConfig } from '../../src/config/schema.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-mcp-caldav-'));
const SERVER = join(process.cwd(), 'connectors', 'caldav', 'server', 'server.mjs');
const NOW = 1_750_000_000_000;

let broker: Server;
let brokerPort = 0;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      broker = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(207, { 'content-type': 'application/xml' });
          res.end('<multistatus><response><vevent/></response></multistatus>');
        });
      });
      broker.listen(0, '127.0.0.1', () => {
        brokerPort = (broker.address() as { port: number }).port;
        resolve();
      });
    }),
);

afterAll(() => {
  broker.close();
  clearMcpActions();
  rmSync(tmp, { recursive: true, force: true });
});

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function caldavServer(): McpServerConfig {
  return {
    name: 'caldav',
    transport: 'stdio',
    command: [process.execPath, SERVER, `127.0.0.1:${brokerPort}`],
    tools: [
      { name: 'events_list', action_class: 'read-only' },
      { name: 'task_delete', action_class: 'irreversible' },
    ],
  };
}

describe('mcp caldav loop (C7)', () => {
  it('events_list read-only; task_delete requires approve', async () => {
    clearMcpActions();
    registerMcpTool('caldav', 'events_list', 'read-only');
    registerMcpTool('caldav', 'task_delete', 'irreversible');

    const queueDb = openDb(join(tmp, 'q.db'));
    const auditDb = openDb(join(tmp, 'a.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const pLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      mcpServers: [caldavServer()],
      mcpRunner: new StdioMcpRunner(),
      gateDeps: { brokerAvailable: true, gateHealthy: true },
    });

    queues.publish(
      'inbound',
      JSON.stringify({
        text: '/mcp caldav task_delete {"href":"/tasks/x.ics"}',
        session_id: 'tg:1',
      }),
      'owner',
    );
    await orch.processOne();

    expect(pending.countActive()).toBe(1);
  });
});
