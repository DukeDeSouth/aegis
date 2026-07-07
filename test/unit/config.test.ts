import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.ts';

const validProfile = {
  base_url: 'http://localhost:11434/v1',
  model: 'qwen3:14b',
  key_ref: 'AEGIS_LLM_KEY',
  max_tokens: 4096,
};

const validTelegram = {
  bot_token_ref: 'AEGIS_TG_BOT_TOKEN',
  pairing_code_ref: 'AEGIS_TG_PAIRING_CODE',
};

const validConfig = {
  llm: { p_llm: validProfile, q_llm: validProfile },
  telegram: validTelegram,
};

describe('configSchema (ADR-0008)', () => {
  it('принимает валидный конфиг с двумя профилями и telegram-секцией', () => {
    const parsed = configSchema.parse(validConfig);
    expect(parsed.llm.q_llm.model).toBe('qwen3:14b');
    expect(parsed.telegram.poll_timeout_s).toBe(30); // default
  });

  it('отклоняет секрет в конфиге: лишнее поле api_key не проходит .strict()', () => {
    const withSecret = { ...validProfile, api_key: 'sk-oops' };
    expect(() =>
      configSchema.parse({ ...validConfig, llm: { p_llm: withSecret, q_llm: validProfile } }),
    ).toThrow();
  });

  it('отклоняет key_ref, похожий на значение ключа, а не имя env-переменной', () => {
    const badRef = { ...validProfile, key_ref: 'sk-abc123' };
    expect(() =>
      configSchema.parse({ ...validConfig, llm: { p_llm: badRef, q_llm: validProfile } }),
    ).toThrow();
  });

  it('data_dir: default ./data, пустая строка отклоняется', () => {
    expect(configSchema.parse(validConfig).data_dir).toBe('./data');
    expect(configSchema.parse({ ...validConfig, data_dir: '/var/lib/aegis' }).data_dir).toBe(
      '/var/lib/aegis',
    );
    expect(() => configSchema.parse({ ...validConfig, data_dir: '' })).toThrow();
  });

  it('skills_dir: default ./skills (Sprint 8)', () => {
    expect(configSchema.parse(validConfig).skills_dir).toBe('./skills');
  });

  it('telegram-секция обязательна (Sprint 2, MVP Telegram-first)', () => {
    expect(() => configSchema.parse({ llm: validConfig.llm })).toThrow();
  });

  it('отклоняет сырой токен бота вместо ref (нижний регистр/двоеточие — не имя env)', () => {
    const raw = { ...validTelegram, bot_token_ref: '1234567890:AAFakeToken' };
    expect(() => configSchema.parse({ ...validConfig, telegram: raw })).toThrow();
  });

  it('poll_timeout_s ограничен диапазоном 0..50', () => {
    expect(() =>
      configSchema.parse({ ...validConfig, telegram: { ...validTelegram, poll_timeout_s: 60 } }),
    ).toThrow();
    expect(
      configSchema.parse({ ...validConfig, telegram: { ...validTelegram, poll_timeout_s: 0 } })
        .telegram.poll_timeout_s,
    ).toBe(0);
  });

  it('learning: default self_improvement_llm_enabled false (Sprint 10)', () => {
    const parsed = configSchema.parse(validConfig);
    expect(parsed.learning.self_improvement_llm_enabled).toBe(false);
    expect(parsed.learning.min_reuse_rate).toBe(0);
  });

  it('memory.context: defaults (Sprint 11)', () => {
    const parsed = configSchema.parse({
      ...validConfig,
      memory: { context: {} },
    });
    expect(parsed.memory?.context.enabled).toBe(true);
    expect(parsed.memory?.context.dialog_tail).toBe(10);
    expect(parsed.memory?.context.recall_k).toBe(3);
    expect(parsed.memory?.context.max_tokens).toBe(2048);
  });

  it('web: defaults (Sprint 12)', () => {
    const parsed = configSchema.parse({ ...validConfig, web: {} });
    expect(parsed.web?.max_response_kb).toBe(512);
    expect(parsed.web?.broker_host).toBe('aegis-broker:8080');
  });

  it('web.search_url: требует {query} и валидный URL (Sprint 23, C2)', () => {
    const url = 'https://searxng.aegis/search?q={query}&format=json';
    const parsed = configSchema.parse({ ...validConfig, web: { search_url: url } });
    expect(parsed.web?.search_url).toBe(url);
    expect(() =>
      configSchema.parse({ ...validConfig, web: { search_url: 'https://x.example/no-slot' } }),
    ).toThrow();
    expect(() =>
      configSchema.parse({ ...validConfig, web: { search_url: 'not-a-url-{query}' } }),
    ).toThrow();
  });
});
