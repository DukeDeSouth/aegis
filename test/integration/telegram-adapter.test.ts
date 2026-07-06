/**
 * E2E Sprint 2: Telegram-адаптер на реальных queue.db/audit.db с мок-fetch Bot API
 * и фейковым LLM. Проверяет DoD: владелец после pairing получает ответ;
 * чужие и недоверенный контент отклоняются с audit-следом; провенанс 'owner'
 * на каждом принятом; цепочка audit верифицируется; токен бота не течёт.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramAdapter, chatIdFromSession } from '../../src/host/adapter/adapter.ts';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { TelegramClient, type TgUpdate } from '../../src/host/adapter/telegram-client.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import type { OrchestratorOptions } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-tg-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TOKEN_REF = 'AEGIS_E2E_TG_TOKEN';
const CODE_REF = 'AEGIS_E2E_TG_CODE';
const FAKE_TOKEN = '1234567890:AAFakeBotTokenForE2E';
const PAIRING_CODE = 'correct-horse-battery';
const OWNER_ID = 42;
const OWNER_CHAT = 10;

beforeEach(() => {
  process.env[TOKEN_REF] = FAKE_TOKEN;
  process.env[CODE_REF] = PAIRING_CODE;
});
afterEach(() => {
  delete process.env[TOKEN_REF];
  delete process.env[CODE_REF];
});

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

/** Скриптованный Bot API: очередь батчей для getUpdates, запись всех sendMessage. */
class FakeTelegram {
  readonly batches: TgUpdate[][] = [];
  readonly sent: { chat_id: number; text: string }[] = [];

  readonly fetchFn: typeof fetch = (url, init) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const body = JSON.parse(init?.body as string) as { chat_id: number; text: string };
    if (u.endsWith('/getUpdates')) {
      const batch = this.batches.shift() ?? [];
      return Promise.resolve(json({ ok: true, result: batch }));
    }
    if (u.endsWith('/sendMessage')) {
      this.sent.push({ chat_id: body.chat_id, text: body.text });
      return Promise.resolve(json({ ok: true, result: {} }));
    }
    return Promise.resolve(json({ ok: false }, 404));
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface World {
  queues: QueueStore;
  audit: AuditLog;
  auditDb: Database.Database;
  queueDb: Database.Database;
  memoryDb: Database.Database;
  state: ChannelState;
  tg: FakeTelegram;
  adapter: TelegramAdapter;
  runReceiverToEnd: () => Promise<void>;
}

function makeWorld(name: string): World {
  const queueDb = openDb(join(tmp, `${name}-queue.db`));
  const auditDb = openDb(join(tmp, `${name}-audit.db`));
  const memoryDb = openDb(join(tmp, `${name}-memory.db`));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0002-queue.sql'), 2);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  applyMigration(memoryDb, migration('0001-memory.sql'), 1);

  const queues = new QueueStore(queueDb);
  const audit = new AuditLog(auditDb);
  const state = new ChannelState(queueDb);
  const tg = new FakeTelegram();
  const client = new TelegramClient(TOKEN_REF, { fetchFn: tg.fetchFn, pollTimeoutS: 0 });

  // Скрипт исчерпан → пустой батч → адаптер зовёт sleep → abort: детерминированный выход.
  const ac = new AbortController();
  const adapter = new TelegramAdapter(client, queues, audit, state, CODE_REF, {
    worker: 'adapter-1',
    sleep: () => {
      ac.abort();
      return Promise.resolve();
    },
  });
  return {
    queues,
    audit,
    auditDb,
    queueDb,
    memoryDb,
    state,
    tg,
    adapter,
    runReceiverToEnd: () => adapter.runReceiver(ac.signal),
  };
}

function msg(
  updateId: number,
  fromId: number,
  text?: string,
  extra: Record<string, unknown> = {},
): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId },
      chat: { id: OWNER_CHAT },
      ...(text !== undefined && { text }),
      ...extra,
    },
  };
}

function makeOrchestrator(w: World, llm: LlmClient, opts: OrchestratorOptions = {}): Orchestrator {
  const pending = new PendingStore(w.queueDb);
  const episodes = new EpisodeStore(w.memoryDb);
  const knowledge = new KnowledgeStore(w.memoryDb);
  return new Orchestrator(w.queues, w.audit, llm, pending, { episodes, knowledge, ...opts });
}

function fakeLlm(): LlmClient {
  return {
    complete(req): Promise<LlmResult> {
      const userText = req.messages.find((m) => m.role === 'user')?.content ?? '';
      return Promise.resolve({
        message: { role: 'assistant', content: `echo: ${userText}` },
        usage: { promptTokens: 1, completionTokens: 1, estimated: false },
      });
    },
  };
}

function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

describe('telegram adapter (e2e, DoD Sprint 2)', () => {
  it('полный путь: pairing → сообщение владельца → forward в quarantine', async () => {
    const w = makeWorld('full');
    w.tg.batches.push(
      [msg(1, 999, 'хочу доступ')], // незнакомец
      [msg(2, OWNER_ID, '/pair wrong-code')], // неверный код
      [msg(3, OWNER_ID, `/pair ${PAIRING_CODE}`)], // pairing
      [msg(4, OWNER_ID, 'привет')], // владелец
      [msg(5, OWNER_ID, 'fwd', { forward_origin: { type: 'user' } })], // пересланное
    );

    await w.runReceiverToEnd();

    // Deny-by-default: owner text + forward enqueued as quarantine
    const first = w.queues.claim('inbound', 'probe');
    expect(first).toBeDefined();
    expect(first?.provenance).toBe('owner');
    expect(JSON.parse(first!.payload)).toEqual({
      text: 'привет',
      session_id: `tg:${OWNER_CHAT}`,
    });
    const second = w.queues.claim('inbound', 'probe');
    expect(second?.provenance).toBe('quarantine');
    expect(JSON.parse(second!.payload)).toMatchObject({
      kind: 'quarantine_content',
      source: 'forwarded',
      body: 'fwd',
      session_id: `tg:${OWNER_CHAT}`,
    });
    expect(w.queues.claim('inbound', 'probe')).toBeUndefined();

    const actions = auditActions(w.auditDb);
    expect(actions).toEqual([
      'message.denied_stranger',
      'pairing.failed',
      'channel.paired',
      'message.accepted',
      'message.quarantine_enqueued',
    ]);

    expect(w.tg.sent.map((s) => s.chat_id)).toEqual([OWNER_CHAT]);
    expect(w.tg.sent[0]?.text).toContain('Paired');

    // Pairing и offset сохранены (переживут рестарт)
    expect(w.state.getOwnerUserId()).toBe(OWNER_ID);
    expect(w.state.getOffset()).toBe(6);

    // Цепочка audit цела; токен бота и pairing-код не текут
    expect(w.audit.verifyChain()).toEqual({ ok: true, entries: 5 });
    const dump = w.auditDb
      .prepare('SELECT * FROM audit_log')
      .all()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(dump).not.toContain(FAKE_TOKEN);
    expect(dump).not.toContain(PAIRING_CODE);
  });

  it('мост очередей: inbound → оркестратор (фейковый LLM) → outbound → sendMessage', async () => {
    const w = makeWorld('bridge');
    w.tg.batches.push([msg(1, OWNER_ID, `/pair ${PAIRING_CODE}`)], [msg(2, OWNER_ID, 'ping')]);
    await w.runReceiverToEnd();

    const orchestrator = makeOrchestrator(w, fakeLlm(), { worker: 'orch-1' });
    expect(await orchestrator.processOne()).toBe(true);

    expect(await w.adapter.processOutbound()).toBe(true);
    expect(w.tg.sent.at(-1)).toEqual({ chat_id: OWNER_CHAT, text: 'echo: ping' });

    // Outbound пуст (ack), цепочка с двумя акторами сходится
    expect(await w.adapter.processOutbound()).toBe(false);
    expect(w.audit.verifyChain()).toMatchObject({ ok: true });
    expect(auditActions(w.auditDb)).toContain('message.sent');
  });

  it('повторный /pair после pairing\u0027а отклоняется — владелец не перезаписывается', async () => {
    const w = makeWorld('repair');
    w.tg.batches.push(
      [msg(1, OWNER_ID, `/pair ${PAIRING_CODE}`)],
      [msg(2, 999, `/pair ${PAIRING_CODE}`)], // чужой с верным кодом после pairing'а
    );
    await w.runReceiverToEnd();

    expect(w.state.getOwnerUserId()).toBe(OWNER_ID);
    expect(auditActions(w.auditDb)).toEqual(['channel.paired', 'pairing.denied']);
  });

  it('outbound с не-telegram session_id уходит в dead, не в sendMessage', async () => {
    const w = makeWorld('foreign');
    w.queues.publish('outbound', JSON.stringify({ text: 'x', session_id: 's1' }), 'system');

    expect(await w.adapter.processOutbound()).toBe(true);
    expect(w.tg.sent).toHaveLength(0);
    expect(auditActions(w.auditDb)).toEqual(['message.send_malformed']);
    expect(w.queues.claim('outbound', 'probe')).toBeUndefined();
  });

  it('409 Conflict останавливает receiver (fail-closed) с записью в audit', async () => {
    const w = makeWorld('conflict');
    const client = new TelegramClient(TOKEN_REF, {
      fetchFn: () => Promise.resolve(json({ ok: false, error_code: 409 }, 409)),
      pollTimeoutS: 0,
    });
    const adapter = new TelegramAdapter(client, w.queues, w.audit, w.state, CODE_REF);

    const ac = new AbortController();
    // Без abort'а: receiver обязан выйти сам по conflict
    await adapter.runReceiver(ac.signal);
    expect(auditActions(w.auditDb)).toEqual(['channel.conflict']);
  });

  it('транзиентная ошибка сети: backoff и восстановление, audit только на смену состояния', async () => {
    const w = makeWorld('backoff');
    let calls = 0;
    const client = new TelegramClient(TOKEN_REF, {
      fetchFn: () => {
        calls++;
        if (calls <= 3) return Promise.reject(new TypeError('fetch failed'));
        return Promise.resolve(json({ ok: true, result: [] }));
      },
      pollTimeoutS: 0,
    });
    const sleeps: number[] = [];
    const ac = new AbortController();
    const adapter = new TelegramAdapter(client, w.queues, w.audit, w.state, CODE_REF, {
      sleep: (ms) => {
        sleeps.push(ms);
        if (calls >= 4) ac.abort(); // после успешного пустого батча выходим
        return Promise.resolve();
      },
    });
    await adapter.runReceiver(ac.signal);

    // Экспоненциальный backoff: 1s, 2s, 4s между ошибками
    expect(sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    // Одна запись о падении и одна о восстановлении — не по записи на итерацию
    expect(auditActions(w.auditDb)).toEqual(['channel.poll_failed', 'channel.poll_recovered']);
  });

  it('chatIdFromSession: парсит только tg-префикс', () => {
    expect(chatIdFromSession('tg:123')).toBe(123);
    expect(chatIdFromSession('s1')).toBeUndefined();
    expect(chatIdFromSession('tg:not-a-number')).toBeUndefined();
  });

  it('без env pairing-кода адаптер не стартует (fail-closed)', () => {
    const w = makeWorld('noenv');
    delete process.env[CODE_REF];
    const client = new TelegramClient(TOKEN_REF, { fetchFn: w.tg.fetchFn, pollTimeoutS: 0 });
    expect(() => new TelegramAdapter(client, w.queues, w.audit, w.state, CODE_REF)).toThrow(
      /not set/,
    );
  });
});
