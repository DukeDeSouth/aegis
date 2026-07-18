/**
 * E2E Sprint 36 / U2: voice reply trigger → outbound with voice_rel_path.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { StaticVoiceSynthesizer } from '../../src/host/adapter/voice.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { DEFAULT_MEMORY_CONTEXT } from '../../src/memory/context.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function fakeLlm(reply: string): LlmClient {
  return {
    complete(): Promise<LlmResult> {
      return Promise.resolve({
        message: { role: 'assistant', content: reply },
        usage: { promptTokens: 5, completionTokens: 3, estimated: false },
      });
    },
  };
}

describe('orchestrator voice reply (U2)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('«ответь голосом» → outbound with voice_rel_path', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aegis-voice-loop-'));
    dirs.push(tmp);

    const queueDb = openDb(join(tmp, 'queue.db'));
    const auditDb = openDb(join(tmp, 'audit.db'));
    const memoryDb = openDb(join(tmp, 'memory.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0002-queue.sql'), 2);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);

    const queues = new QueueStore(queueDb);
    const audit = new AuditLog(auditDb);
    const pending = new PendingStore(queueDb);
    const channelState = new ChannelState(queueDb);
    const episodes = new EpisodeStore(memoryDb);

    const orch = new Orchestrator(queues, audit, fakeLlm('Солнечно, +22'), pending, {
      worker: 'orch-voice',
      episodes,
      channelState,
      voiceSynthesizer: new StaticVoiceSynthesizer(),
      memoryContext: { ...DEFAULT_MEMORY_CONTEXT, enabled: false },
    });

    queues.publish(
      'inbound',
      JSON.stringify({
        text: 'ответь голосом: какая погода?',
        session_id: 'tg:42',
      }),
      'owner',
    );

    expect(await orch.processOne()).toBe(true);

    const out = queues.claim('outbound', 'probe');
    expect(out).toBeDefined();
    const payload = JSON.parse(out!.payload) as {
      text: string;
      session_id: string;
      voice_rel_path?: string;
    };
    expect(payload.text).toBe('Солнечно, +22');
    expect(payload.voice_rel_path).toMatch(/^outgoing\/[a-f0-9]+\.ogg$/);
  });
});
