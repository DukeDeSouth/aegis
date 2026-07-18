/**
 * E2E Sprint 33 / U1: Telegram voice → STT → quarantine inbound.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/host/adapter/adapter.ts';
import { ChannelState } from '../../src/host/adapter/state.ts';
import { StaticVoiceTranscriber } from '../../src/host/adapter/voice.ts';
import { TelegramClient, type TgUpdate } from '../../src/host/adapter/telegram-client.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-voice-tg-'));
const wsDir = mkdtempSync(join(tmpdir(), 'aegis-voice-ws-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(wsDir, { recursive: true, force: true });
});

const TOKEN_REF = 'AEGIS_VOICE_TG_TOKEN';
const CODE_REF = 'AEGIS_VOICE_TG_CODE';
const FAKE_TOKEN = '1234567890:AAFakeBotTokenForVoice';
const PAIRING_CODE = 'voice-battery-staple';
const OWNER_ID = 42;
const OWNER_CHAT = 10;
const TRANSCRIPT = 'привет из голосовой заметки';

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

class VoiceFakeTelegram {
  readonly batches: TgUpdate[][] = [];
  readonly sent: { chat_id: number; text: string }[] = [];

  readonly fetchFn: typeof fetch = (url, init) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u.endsWith('/getUpdates')) {
      const batch = this.batches.shift() ?? [];
      return Promise.resolve(json({ ok: true, result: batch }));
    }
    if (u.endsWith('/sendMessage')) {
      const body = JSON.parse(init?.body as string) as { chat_id: number; text: string };
      this.sent.push({ chat_id: body.chat_id, text: body.text });
      return Promise.resolve(json({ ok: true, result: {} }));
    }
    if (u.endsWith('/getFile')) {
      return Promise.resolve(
        json({ ok: true, result: { file_path: 'voice/file.ogg', file_size: 128 } }),
      );
    }
    if (u.includes('/file/bot')) {
      return Promise.resolve(new Response(Buffer.from('fake-ogg-bytes'), { status: 200 }));
    }
    return Promise.resolve(json({ ok: false }, 404));
  };
}

function voiceMsg(updateId: number): TgUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: OWNER_ID },
      chat: { id: OWNER_CHAT },
      voice: {
        file_id: 'voice-file-id',
        file_unique_id: 'voice-unique-1',
        duration: 3,
        file_size: 128,
      },
    },
  };
}

describe('telegram voice (U1)', () => {
  it('voice от владельца → quarantine inbound с transcript', async () => {
    const queueDb = openDb(join(tmp, 'voice-queue.db'));
    const auditDb = openDb(join(tmp, 'voice-audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0002-queue.sql'), 2);
    applyMigration(queueDb, migration('0003-queue.sql'), 3);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const queues = new QueueStore(queueDb);
    const audit = new AuditLog(auditDb);
    const state = new ChannelState(queueDb);
    state.setOwnerUserId(OWNER_ID);

    const tg = new VoiceFakeTelegram();
    tg.batches.push([voiceMsg(1)]);

    const client = new TelegramClient(TOKEN_REF, { fetchFn: tg.fetchFn, pollTimeoutS: 0 });
    const ac = new AbortController();
    const adapter = new TelegramAdapter(client, queues, audit, state, CODE_REF, {
      worker: 'voice-test',
      sleep: () => {
        ac.abort();
        return Promise.resolve();
      },
      voiceTranscriber: new StaticVoiceTranscriber(TRANSCRIPT),
      workspaceDir: wsDir,
    });

    await adapter.runReceiver(ac.signal);

    const msg = queues.claim('inbound', 'probe');
    expect(msg?.provenance).toBe('quarantine');
    expect(JSON.parse(msg!.payload)).toEqual({
      kind: 'quarantine_content',
      source: 'voice',
      body: TRANSCRIPT,
      session_id: `tg:${OWNER_CHAT}`,
    });

    const actions = (auditDb.prepare('SELECT action FROM audit_log').all() as { action: string }[])
      .map((r) => r.action);
    expect(actions).toContain('voice.transcribed');
  });
});
