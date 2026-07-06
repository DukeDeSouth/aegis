import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramClient, TelegramError } from '../../src/host/adapter/telegram-client.ts';

const TOKEN_REF = 'AEGIS_TEST_TG_TOKEN';
const FAKE_TOKEN = '1234567890:AAFakeTokenValue';

beforeEach(() => {
  process.env[TOKEN_REF] = FAKE_TOKEN;
});
afterEach(() => {
  delete process.env[TOKEN_REF];
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function urlOf(u: Parameters<typeof fetch>[0]): string {
  if (typeof u === 'string') return u;
  return u instanceof URL ? u.href : u.url;
}

function clientWith(fetchFn: typeof fetch): TelegramClient {
  return new TelegramClient(TOKEN_REF, { fetchFn, pollTimeoutS: 0 });
}

describe('TelegramClient', () => {
  it('без env-переменной токена конструктор кидает (fail-closed)', () => {
    delete process.env[TOKEN_REF];
    expect(() => new TelegramClient(TOKEN_REF)).toThrow(/not set/);
  });

  it('getUpdates: передаёт offset/timeout/allowed_updates и возвращает result', async () => {
    let captured: { url: string; body: unknown } | undefined;
    const client = clientWith((url, init) => {
      captured = { url: urlOf(url), body: JSON.parse(init?.body as string) };
      return Promise.resolve(jsonResponse({ ok: true, result: [{ update_id: 7 }] }));
    });

    const updates = await client.getUpdates(5);
    expect(updates).toEqual([{ update_id: 7 }]);
    expect(captured?.url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`);
    expect(captured?.body).toEqual({ offset: 5, timeout: 0, allowed_updates: ['message'] });
  });

  it('sendMessage: отправляет chat_id и text', async () => {
    let body: unknown;
    const client = clientWith((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Promise.resolve(jsonResponse({ ok: true, result: {} }));
    });
    await client.sendMessage(10, 'hello');
    expect(body).toEqual({ chat_id: 10, text: 'hello' });
  });

  it('429 → transient с retryAfterMs из parameters.retry_after', async () => {
    const client = clientWith(() =>
      Promise.resolve(
        jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429),
      ),
    );
    const err = await client.getUpdates(undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).transient).toBe(true);
    expect((err as TelegramError).retryAfterMs).toBe(7000);
  });

  it('409 → conflict, не transient', async () => {
    const client = clientWith(() =>
      Promise.resolve(jsonResponse({ ok: false, error_code: 409 }, 409)),
    );
    const err = await client.getUpdates(undefined).catch((e: unknown) => e);
    expect((err as TelegramError).conflict).toBe(true);
    expect((err as TelegramError).transient).toBe(false);
  });

  it('500 → transient; 400 → permanent', async () => {
    const c500 = clientWith(() => Promise.resolve(jsonResponse({ ok: false }, 500)));
    const e500 = await c500.getUpdates(undefined).catch((e: unknown) => e);
    expect((e500 as TelegramError).transient).toBe(true);

    const c400 = clientWith(() =>
      Promise.resolve(jsonResponse({ ok: false, error_code: 400 }, 400)),
    );
    const e400 = await c400.sendMessage(1, 'x').catch((e: unknown) => e);
    expect((e400 as TelegramError).transient).toBe(false);
    expect((e400 as TelegramError).conflict).toBe(false);
  });

  it('сетевая ошибка → transient, текст ошибки не содержит токен/URL (R2)', async () => {
    const client = clientWith(() =>
      Promise.reject(new TypeError(`fetch failed: https://api.telegram.org/bot${FAKE_TOKEN}/x`)),
    );
    const err = await client.getUpdates(undefined).catch((e: unknown) => e);
    expect((err as TelegramError).transient).toBe(true);
    expect((err as TelegramError).message).not.toContain(FAKE_TOKEN);
  });

  it('HTTP-ошибка: текст ошибки не содержит токен', async () => {
    const client = clientWith(() => Promise.resolve(jsonResponse({ ok: false }, 500)));
    const err = await client.getUpdates(undefined).catch((e: unknown) => e);
    expect((err as TelegramError).message).not.toContain(FAKE_TOKEN);
  });
});
