import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError, OpenAiCompatClient } from '../../src/llm/client.ts';
import type { LlmProfile } from '../../src/config/schema.ts';

const profile: LlmProfile = {
  base_url: 'http://llm.test/v1',
  model: 'test-model',
  key_ref: 'AEGIS_TEST_LLM_KEY',
  max_tokens: 100,
};

const noSleep = (): Promise<void> => Promise.resolve();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = {
  choices: [{ message: { role: 'assistant', content: 'hello' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

beforeEach(() => {
  process.env.AEGIS_TEST_LLM_KEY = 'sk-fake-test-key';
});
afterEach(() => {
  delete process.env.AEGIS_TEST_LLM_KEY;
});

describe('OpenAiCompatClient', () => {
  it('fail-closed: отсутствие ключа в env — ошибка на старте', () => {
    delete process.env.AEGIS_TEST_LLM_KEY;
    expect(() => new OpenAiCompatClient(profile)).toThrow(/AEGIS_TEST_LLM_KEY/);
  });

  it('happy path: message и точный usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const client = new OpenAiCompatClient(profile, { fetch: fetchMock, sleep: noSleep });

    const res = await client.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });
    expect(res.message.content).toBe('hello');
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, estimated: false });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://llm.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-fake-test-key');
  });

  it('без usage от провайдера — верхняя оценка с estimated: true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = new OpenAiCompatClient(profile, { fetch: fetchMock, sleep: noSleep });

    const res = await client.complete({
      messages: [{ role: 'user', content: 'x'.repeat(30) }],
      maxTokens: 100,
    });
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 100, estimated: true });
  });

  it('429 → retry → успех', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(okBody));
    const client = new OpenAiCompatClient(profile, { fetch: fetchMock, sleep: noSleep });

    const res = await client.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });
    expect(res.message.content).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('400 — нетранзиентная ошибка, без retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 400));
    const client = new OpenAiCompatClient(profile, { fetch: fetchMock, sleep: noSleep });

    await expect(
      client.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }),
    ).rejects.toSatisfy((e: unknown) => e instanceof LlmError && !e.transient);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('стабильные 5xx исчерпывают попытки и дают транзиентную ошибку', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const client = new OpenAiCompatClient(profile, { fetch: fetchMock, sleep: noSleep });

    await expect(
      client.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }),
    ).rejects.toSatisfy((e: unknown) => e instanceof LlmError && e.transient);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('сетевая ошибка транзиентна и ретраится', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(okBody));
    const client = new OpenAiCompatClient(profile, { fetch: fetchMock, sleep: noSleep });

    const res = await client.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });
    expect(res.message.content).toBe('hello');
  });
});
