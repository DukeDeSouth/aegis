/**
 * E2E Sprint 36 / U2: outbound voice_rel_path → Telegram sendVoice.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/host/adapter/adapter.ts';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { TelegramClient } from '../../src/host/adapter/telegram-client.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-voice-out-'));
const wsDir = mkdtempSync(join(tmpdir(), 'aegis-voice-out-ws-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
});

const TOKEN_REF = 'AEGIS_VOICE_OUT_TG_TOKEN';
const CODE_REF = 'AEGIS_VOICE_OUT_TG_CODE';
const FAKE_TOKEN = '1234567890:AAFakeBotTokenForVoiceOut';
const PAIRING_CODE = 'voice-out-staple';
const OWNER_ID = 7;
const OWNER_CHAT = 11;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

class VoiceOutFakeTelegram {
  readonly voices: { chat_id: number; bytes: number }[] = [];
  readonly messages: { chat_id: number; text: string }[] = [];

  readonly fetchFn: typeof fetch = (url, init) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u.endsWith('/sendVoice')) {
      const form = init?.body as FormData;
      const chatId = Number(form.get('chat_id'));
      const blob = form.get('voice') as Blob;
      return blob.arrayBuffer().then((buf) => {
        this.voices.push({ chat_id: chatId, bytes: buf.byteLength });
        return json({ ok: true, result: {} });
      });
    }
    if (u.endsWith('/sendMessage')) {
      const body = JSON.parse(init?.body as string) as { chat_id: number; text: string };
      this.messages.push({ chat_id: body.chat_id, text: body.text });
      return Promise.resolve(json({ ok: true, result: {} }));
    }
    return Promise.resolve(json({ ok: false }, 404));
  };
}

describe('telegram voice reply outbound (U2)', () => {
  it('voice_rel_path → sendVoice with workspace file', async () => {
    const queueDb = openDb(join(tmp, 'voice-out-queue.db'));
    const auditDb = openDb(join(tmp, 'voice-out-audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0002-queue.sql'), 2);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const rel = 'outgoing/reply.ogg';
    mkdirSync(join(wsDir, 'outgoing'), { recursive: true });
    writeFileSync(join(wsDir, rel), Buffer.from('OggSfake'));

    const queues = new QueueStore(queueDb);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    state.setOwnerUserId(OWNER_ID);

    queues.publish(
      'outbound',
      JSON.stringify({
        text: 'погода солнечная',
        session_id: `tg:${OWNER_CHAT}`,
        voice_rel_path: rel,
      }),
      'system',
    );

    const tg = new VoiceOutFakeTelegram();
    const client = new TelegramClient(TOKEN_REF, { fetchFn: tg.fetchFn, pollTimeoutS: 0 });
    const ac = new AbortController();
    const adapter = new TelegramAdapter(client, queues, audit, state, CODE_REF, {
      worker: 'voice-out-test',
      sleep: () => {
        ac.abort();
        return Promise.resolve();
      },
      workspaceDir: wsDir,
    });

    await adapter.runSender(ac.signal);

    expect(tg.voices).toEqual([{ chat_id: OWNER_CHAT, bytes: 8 }]);
    expect(tg.messages).toHaveLength(0);

    const actions = (auditDb.prepare('SELECT action FROM audit_log').all() as { action: string }[])
      .map((r) => r.action);
    expect(actions).toContain('message.sent_voice');
  });
});
