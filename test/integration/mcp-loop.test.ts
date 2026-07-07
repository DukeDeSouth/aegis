/**
 * E2E F8: MCP через gate → quarantine Q→P.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { clearMcpActions, registerMcpTool } from '../../src/host/gate/mcp-actions.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QuarantineProcessor } from '../../src/host/quarantine/processor.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { StdioMcpRunner } from '../../src/mcp/runner.ts';
import type { McpServerConfig } from '../../src/config/schema.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-mcp-'));
const ECHO_SERVER = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/echo-server.mjs');
const NOW = 1_750_000_000_000;

afterAll(() => {
  clearMcpActions();
  rmSync(tmp, { recursive: true, force: true });
});

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

const echoServer: McpServerConfig = {
  name: 'echo',
  transport: 'stdio',
  command: [process.execPath, ECHO_SERVER],
  tools: [{ name: 'echo', action_class: 'read-only' }],
};

registerMcpTool('echo', 'echo', 'read-only');

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('mcp loop', () => {
  it('owner /mcp echo → quarantine path with mcp source', async () => {
    const queueDb = openDb(join(tmp, 'q1.db'));
    const auditDb = openDb(join(tmp, 'a1.db'));
    const memoryDb = openDb(join(tmp, 'm1.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const episodes = new EpisodeStore(memoryDb, { now: () => NOW });
    const knowledge = new KnowledgeStore(memoryDb, { now: () => NOW });

    let pSystem = '';
    const pLlm: LlmClient = {
      complete(req): Promise<LlmResult> {
        pSystem = req.messages.find((m) => m.role === 'system')?.content ?? '';
        return Promise.resolve({
          message: { role: 'assistant', content: 'mcp output handled' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const qLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'safe summary of mcp output' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      episodes,
      knowledge,
      quarantine: new QuarantineProcessor(qLlm, { maxTokens: 512 }),
      mcpServers: [echoServer],
      mcpRunner: new StdioMcpRunner(),
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/mcp echo echo {"text":"from-mcp"}', session_id: 'tg:1' }),
      'owner',
    );
    await orch.processOne();

    const out = queues.claim('outbound', 'probe');
    expect(out).toBeDefined();
    const payload = JSON.parse(out!.payload) as { text: string };
    expect(payload.text).toContain('mcp output handled');

    const actions = auditActions(auditDb);
    expect(actions).toContain('mcp.echo.echo');
    expect(actions).toContain('mcp.tool.completed');
    expect(actions).toContain('quarantine.completed');
    expect(pSystem).toContain('Untrusted content');
  });

  it('unmapped tool denied without mcp call', async () => {
    const queueDb = openDb(join(tmp, 'q2.db'));
    const auditDb = openDb(join(tmp, 'a2.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const orch = new Orchestrator(queues, audit, {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'x' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    }, pending, {
      mcpServers: [echoServer],
      mcpRunner: new StdioMcpRunner(),
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/mcp echo unknown {}', session_id: 'tg:2' }),
      'owner',
    );
    await orch.processOne();

    const out = queues.claim('outbound', 'probe');
    const payload = JSON.parse(out!.payload) as { text: string };
    expect(payload.text).toContain('not mapped');
    expect(auditActions(auditDb)).not.toContain('mcp.tool.completed');
  });

  it('irreversible MCP tool → pending → approve → quarantine', async () => {
    clearMcpActions();
    registerMcpTool('echo', 'echo', 'irreversible');

    const queueDb = openDb(join(tmp, 'q3.db'));
    const auditDb = openDb(join(tmp, 'a3.db'));
    const memoryDb = openDb(join(tmp, 'm3.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);

    const echoIrreversible: McpServerConfig = {
      ...echoServer,
      tools: [{ name: 'echo', action_class: 'irreversible' }],
    };

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const qLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'summary' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const pLlm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'done' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const orch = new Orchestrator(queues, audit, pLlm, pending, {
      quarantine: new QuarantineProcessor(qLlm, { maxTokens: 512 }),
      mcpServers: [echoIrreversible],
      mcpRunner: new StdioMcpRunner(),
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/mcp echo echo {"text":"after-approve"}', session_id: 'tg:3' }),
      'owner',
    );
    await orch.processOne();

    let out = queues.claim('outbound', 'probe');
    const promptText = JSON.parse(out!.payload) as { text: string };
    expect(promptText.text).toContain('/approve');
    expect(auditActions(auditDb)).not.toContain('mcp.tool.completed');

    const tokenMatch = /\/approve\s+(\S+)/.exec(promptText.text);
    expect(tokenMatch).not.toBeNull();
    queues.publish(
      'inbound',
      JSON.stringify({ kind: 'approved_action', token: tokenMatch![1], session_id: 'tg:3' }),
      'owner',
    );
    await orch.processOne();

    out = queues.claim('outbound', 'probe');
    const doneText = JSON.parse(out!.payload) as { text: string };
    expect(doneText.text).toContain('done');
    expect(auditActions(auditDb)).toContain('mcp.tool.completed');
    expect(auditActions(auditDb)).toContain('quarantine.completed');
  });
});
