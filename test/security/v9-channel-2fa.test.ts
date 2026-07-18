/**
 * V9: 2FA — approve из того же канала отклоняется при cross_channel.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { IRREVERSIBLE_TEST_CMD } from '../../src/host/gate/actions.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-v9-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('v9 channel 2FA', () => {
  it('same-channel approve denied; other channel ok', async () => {
    const queueDb = openDb(join(tmp, 'v9-q.db'));
    const auditDb = openDb(join(tmp, 'v9-a.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(queueDb, migration('0009-queue.sql'), 9);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb, { now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };

    const orch = new Orchestrator(queues, audit, llm, pending, {
      secondFactor: { enabled: true, modes: ['cross_channel'], action_classes: ['irreversible'] },
      pairedChannels: () => ({ telegram: true, discord: true, webchat: false, matrix: false, slack: false }),
    });

    queues.publish(
      'inbound',
      JSON.stringify({ text: IRREVERSIBLE_TEST_CMD, session_id: 'tg:1' }),
      'owner',
    );
    await orch.processOne();

    const prompt = JSON.parse(queues.claim('outbound', 't')!.payload) as { text: string };
    expect(prompt.text).toContain('Discord');
    const token = /\/approve\s+(\S+)/.exec(prompt.text)![1]!;

    queues.publish(
      'inbound',
      JSON.stringify({ kind: 'approved_action', token, session_id: 'tg:1' }),
      'owner',
    );
    await orch.processOne();
    expect(auditActions(auditDb)).toContain('approval.wrong_channel');
    expect(pending.peek(token)).not.toBeNull();

    queues.publish(
      'inbound',
      JSON.stringify({ kind: 'approved_action', token, session_id: 'discord:9' }),
      'owner',
    );
    await orch.processOne();
    expect(auditActions(auditDb)).toContain('action.dangerous.executed');
    expect(pending.peek(token)).toBeNull();
  });
});
