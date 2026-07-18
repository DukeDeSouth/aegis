/**
 * E2E Sprint 29: WebChat adapter — pairing, unpaired deny, outbound poll.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebChatAdapter } from '../../src/host/adapter/webchat/adapter.ts';
import { WEBCHAT_DEFAULT_SESSION } from '../../src/host/adapter/channel.ts';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-webchat-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CODE_REF = 'AEGIS_E2E_WEBCHAT_CODE';
const PAIRING = 'webchat-pair-code';
const PORT = 18_791;

beforeEach(() => {
  process.env[CODE_REF] = PAIRING;
});
afterEach(() => {
  delete process.env[CODE_REF];
});

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function applyQueueMigrations(db: ReturnType<typeof openDb>): void {
  applyMigration(db, migration('0001-queue.sql'), 1);
  applyMigration(db, migration('0002-queue.sql'), 2);
  applyMigration(db, migration('0010-queue.sql'), 10);
  applyMigration(db, migration('0014-queue.sql'), 14);
}

function staticRoot(): string {
  const dir = join(tmp, `static-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  return dir;
}

async function waitReady(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('webchat adapter (Sprint 29)', () => {
  it('pairing then message → inbound owner', async () => {
    const queueDb = openDb(join(tmp, 'wc-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT,
      staticRoot: staticRoot(),
      pollMs: 1,
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const base = `http://127.0.0.1:${PORT}`;
    const pairRes = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING }),
    });
    expect(pairRes.status).toBe(200);
    const cookie = pairRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const msgRes = await fetch(`${base}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'hello webchat' }),
    });
    expect(msgRes.status).toBe(200);

    const inbound = queues.claim('inbound', 't');
    expect(inbound).toBeDefined();
    const p = JSON.parse(inbound!.payload) as { text: string; session_id: string };
    expect(p.text).toBe('hello webchat');
    expect(p.session_id).toBe(WEBCHAT_DEFAULT_SESSION);

    queues.publish(
      'outbound',
      JSON.stringify({ text: 'reply from agent', session_id: WEBCHAT_DEFAULT_SESSION }),
      'owner',
    );
    await adapter.processOutbound();

    const pollRes = await fetch(`${base}/api/poll`, { headers: { Cookie: cookie } });
    const pollBody = (await pollRes.json()) as { messages: string[] };
    expect(pollBody.messages).toContain('reply from agent');

    ac.abort();
    await run;
  });

  it('unpaired message denied', async () => {
    const queueDb = openDb(join(tmp, 'wc2-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc2-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 1,
      staticRoot: staticRoot(),
      pollMs: 1,
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const res = await fetch(`http://127.0.0.1:${PORT + 1}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'nope' }),
    });
    expect(res.status).toBe(401);
    expect(queues.claim('inbound', 't')).toBeUndefined();

    ac.abort();
    await run;
  });

  it('already paired: same code reauth → new session cookie', async () => {
    const queueDb = openDb(join(tmp, 'wc3-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc3-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    state.setWebchatPaired();
    state.setWebchatSessionToken('old-token');
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 2,
      staticRoot: staticRoot(),
      pollMs: 1,
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const res = await fetch(`http://127.0.0.1:${PORT + 2}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).not.toContain('old-token');

    const msgRes = await fetch(`http://127.0.0.1:${PORT + 2}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'after reauth' }),
    });
    expect(msgRes.status).toBe(200);

    ac.abort();
    await run;
  });

  it('telegram adapter releases webchat outbound for webchat sender', async () => {
    const queueDb = openDb(join(tmp, 'wc4-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc4-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);

    const { TelegramAdapter } = await import('../../src/host/adapter/adapter.ts');
    const { TelegramClient } = await import('../../src/host/adapter/telegram-client.ts');
    process.env.AEGIS_E2E_TG_TOKEN = '0:test';
    const tg = new TelegramAdapter(
      new TelegramClient('AEGIS_E2E_TG_TOKEN', { pollTimeoutS: 0 }),
      queues,
      audit,
      state,
      CODE_REF,
    );
    const webchat = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 3,
      staticRoot: staticRoot(),
      pollMs: 1,
    });

    const ac = new AbortController();
    const run = webchat.run(ac.signal);
    await waitReady();

    const pairRes = await fetch(`http://127.0.0.1:${PORT + 3}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING }),
    });
    expect(pairRes.status).toBe(200);
    const cookie = pairRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    queues.publish(
      'outbound',
      JSON.stringify({ text: 'routed reply', session_id: WEBCHAT_DEFAULT_SESSION }),
      'system',
    );
    expect(await tg.processOutbound()).toBe(true);
    await waitReady(120);

    const pollRes = await fetch(`http://127.0.0.1:${PORT + 3}/api/poll`, { headers: { Cookie: cookie } });
    const pollBody = (await pollRes.json()) as { messages: string[] };
    expect(pollBody.messages).toContain('routed reply');

    delete process.env.AEGIS_E2E_TG_TOKEN;
    ac.abort();
    await run;
  });

  it('GET /api/actions returns skills and commands when authed', async () => {
    const queueDb = openDb(join(tmp, 'wc5-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc5-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 4,
      staticRoot: staticRoot(),
      pollMs: 1,
      listSkills: () => [
        { name: 'echo-procedure', description: 'Echo', code: false, actionClass: 'read-only' },
      ],
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const base = `http://127.0.0.1:${PORT + 4}`;
    const pairRes = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING }),
    });
    const cookie = pairRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const actionsRes = await fetch(`${base}/api/actions`, { headers: { Cookie: cookie } });
    expect(actionsRes.status).toBe(200);
    const body = (await actionsRes.json()) as {
      actions: { id: string; label: string; kind: string }[];
    };
    expect(body.actions.some((a) => a.id === 'skill-echo-procedure')).toBe(true);
    expect(body.actions.some((a) => a.id === 'cmd-skills')).toBe(true);

    ac.abort();
    await run;
  });

  it('GET /api/history returns authed episode tail', async () => {
    const queueDb = openDb(join(tmp, 'wc6-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc6-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 5,
      staticRoot: staticRoot(),
      pollMs: 1,
      getHistory: () => [
        { id: 10, role: 'user', text: 'stored hello' },
        { id: 11, role: 'bot', text: 'stored reply' },
      ],
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const base = `http://127.0.0.1:${PORT + 5}`;
    const pairRes = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING }),
    });
    const cookie = pairRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const histRes = await fetch(`${base}/api/history`, { headers: { Cookie: cookie } });
    expect(histRes.status).toBe(200);
    const body = (await histRes.json()) as {
      messages: { id: number; role: string; text: string }[];
    };
    expect(body.messages).toEqual([
      { id: 10, role: 'user', text: 'stored hello' },
      { id: 11, role: 'bot', text: 'stored reply' },
    ]);

    const denied = await fetch(`${base}/api/history`);
    expect(denied.status).toBe(401);

    ac.abort();
    await run;
  });

  it('outbound delivered after aborted poll (stale waiter regression)', async () => {
    const queueDb = openDb(join(tmp, 'wc7-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc7-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 6,
      staticRoot: staticRoot(),
      pollMs: 1,
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const base = `http://127.0.0.1:${PORT + 6}`;
    const pairRes = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING }),
    });
    const cookie = pairRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const abortPoll = new AbortController();
    const earlyPoll = fetch(`${base}/api/poll`, {
      headers: { Cookie: cookie },
      signal: abortPoll.signal,
    });
    await waitReady(40);
    abortPoll.abort();
    await earlyPoll.catch(() => undefined);
    await waitReady(200);

    queues.publish(
      'outbound',
      JSON.stringify({ text: 'after abort delivery', session_id: WEBCHAT_DEFAULT_SESSION }),
      'system',
    );
    expect(await adapter.processOutbound()).toBe(true);
    await waitReady(20);

    const pollRes = await fetch(`${base}/api/poll`, { headers: { Cookie: cookie } });
    const pollBody = (await pollRes.json()) as { messages: string[] };
    expect(pollBody.messages).toContain('after abort delivery');

    ac.abort();
    await run;
  });

  it('Sprint 41: CSP headers on API and static', async () => {
    const queueDb = openDb(join(tmp, 'wc-csp-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc-csp-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const staticDir = staticRoot();
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 7,
      staticRoot: staticDir,
      pollMs: 1,
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const base = `http://127.0.0.1:${PORT + 7}`;
    const statusRes = await fetch(`${base}/api/status`);
    expect(statusRes.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(statusRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(statusRes.headers.get('referrer-policy')).toBe('no-referrer');

    const staticRes = await fetch(`${base}/`);
    expect(staticRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    ac.abort();
    await run;
  });

  it('Sprint 41: pairing brute-force lockout after 5 fails, persists across restart', async () => {
    const queueDb = openDb(join(tmp, 'wc-lock-q.db'));
    applyQueueMigrations(queueDb);
    const queues = new QueueStore(queueDb);
    const auditDb = openDb(join(tmp, 'wc-lock-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    const adapter = new WebChatAdapter(queues, audit, state, CODE_REF, {
      port: PORT + 8,
      staticRoot: staticRoot(),
      pollMs: 1,
    });

    const ac = new AbortController();
    const run = adapter.run(ac.signal);
    await waitReady();

    const base = `http://127.0.0.1:${PORT + 8}`;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'wrong-code' }),
      });
      expect(res.status).toBe(403);
    }
    const fifth = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'wrong-code' }),
    });
    expect(fifth.status).toBe(429);

    for (let i = 0; i < 95; i++) {
      const res = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'wrong-code' }),
      });
      expect(res.status).toBe(429);
    }

    ac.abort();
    await run;

    const auditRows = auditDb
      .prepare(`SELECT action FROM audit_log WHERE action = 'pairing.lockout'`)
      .all() as { action: string }[];
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    const reopened = new ChannelState(queueDb);
    expect(reopened.getWebchatPairLockoutUntil()).toBeGreaterThan(Date.now());

    const adapter2 = new WebChatAdapter(queues, audit, reopened, CODE_REF, {
      port: PORT + 9,
      staticRoot: staticRoot(),
      pollMs: 1,
    });
    const ac2 = new AbortController();
    const run2 = adapter2.run(ac2.signal);
    await waitReady();
    const lockedRes = await fetch(`http://127.0.0.1:${PORT + 9}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'wrong-code' }),
    });
    expect(lockedRes.status).toBe(429);
    ac2.abort();
    await run2;
  });
});
