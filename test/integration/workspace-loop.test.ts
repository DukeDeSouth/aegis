/**
 * E2E Sprint 14 / F4: workspace read/write/undo.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { WorkspaceStore } from '../../src/host/workspace.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-ws-loop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;
const wsRoot = join(tmp, 'workspace');

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

describe('workspace loop (F4)', () => {
  it('write → read next turn → undo', async () => {
    const queueDb = openDb(join(tmp, 'ws-q.db'));
    const auditDb = openDb(join(tmp, 'ws-a.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const workspace = new WorkspaceStore(wsRoot, { now: () => NOW });
    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const orch = new Orchestrator(queues, audit, llm, pending, { workspace });
    const session = 'tg:1';

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/write notes.md | quarterly summary', session_id: session }),
      'owner',
    );
    await orch.processOne();
    expect(drainOutbound(queues)[0]).toContain('Wrote notes.md');

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/read notes.md', session_id: session }),
      'owner',
    );
    await orch.processOne();
    expect(drainOutbound(queues)[0]).toContain('quarterly summary');

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/write notes.md | updated', session_id: session }),
      'owner',
    );
    await orch.processOne();
    drainOutbound(queues);

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/undo-file notes.md', session_id: session }),
      'owner',
    );
    await orch.processOne();
    expect(drainOutbound(queues)[0]).toContain('Restored');

    queues.publish(
      'inbound',
      JSON.stringify({ text: '/read notes.md', session_id: session }),
      'owner',
    );
    await orch.processOne();
    expect(drainOutbound(queues)[0]).toContain('quarterly summary');
  });
});
