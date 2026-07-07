/**
 * E2E F10: Discord adapter — pairing, stranger deny, outbound.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscordAdapter } from '../../src/host/adapter/discord/adapter.ts';
import type { DiscordClient } from '../../src/host/adapter/discord/client.ts';
import type { DiscordMessage } from '../../src/host/adapter/discord/policy.ts';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-discord-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CODE_REF = 'AEGIS_E2E_DISCORD_CODE';
const PAIRING = 'discord-pair-code';

beforeEach(() => {
  process.env[CODE_REF] = PAIRING;
});
afterEach(() => {
  delete process.env[CODE_REF];
});

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

class ScriptDiscordClient implements DiscordClient {
  readonly inbox: DiscordMessage[] = [];
  readonly sent: { channelId: string; text: string }[] = [];
  private handler: ((msg: DiscordMessage) => void) | undefined;

  push(msg: DiscordMessage): void {
    this.inbox.push(msg);
    this.handler?.(msg);
  }

  async runGateway(
    onMessage: (msg: DiscordMessage) => void,
    _onSequence: (seq: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.handler = onMessage;
    for (const m of this.inbox) onMessage(m);
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    this.sent.push({ channelId, text });
  }
}

describe('discord adapter (F10)', () => {
  it('pairing then owner message → inbound owner', async () => {
    const queueDb = openDb(join(tmp, 'dc-q.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0002-queue.sql'), 2);
    applyMigration(queueDb, migration('0008-queue.sql'), 8);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'dc-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const client = new ScriptDiscordClient();
    const adapter = new DiscordAdapter(client, queues, audit, state, CODE_REF, { pollMs: 1 });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);

    client.push({
      id: '1',
      channel_id: 'ch1',
      author: { id: 'user-owner' },
      content: `/pair ${PAIRING}`,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.getDiscordOwnerId()).toBe('user-owner');

    client.push({
      id: '2',
      channel_id: 'ch1',
      author: { id: 'user-owner' },
      content: 'hello discord',
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await run;

    const inbound = queues.claim('inbound', 't');
    expect(inbound).toBeDefined();
    const p = JSON.parse(inbound!.payload) as { text: string; session_id: string };
    expect(p.text).toBe('hello discord');
    expect(p.session_id).toBe('discord:ch1');
  });

  it('stranger denied silently', async () => {
    const queueDb = openDb(join(tmp, 'dc2-q.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0002-queue.sql'), 2);
    applyMigration(queueDb, migration('0008-queue.sql'), 8);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'dc2-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    state.setDiscordOwnerId('owner-1');
    const client = new ScriptDiscordClient();
    const adapter = new DiscordAdapter(client, queues, audit, state, CODE_REF, { pollMs: 1 });
    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    client.push({
      id: '9',
      channel_id: 'ch9',
      author: { id: 'stranger' },
      content: 'hi',
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await run;
    expect(queues.claim('inbound', 't')).toBeUndefined();
    const actions = (auditDb.prepare('SELECT action FROM audit_log').all() as { action: string }[]).map(
      (r) => r.action,
    );
    expect(actions).toContain('message.denied_stranger');
  });
});
