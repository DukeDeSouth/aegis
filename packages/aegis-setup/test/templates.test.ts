import { describe, expect, it } from 'vitest';
import { generateConfig, generatePairingCode } from '../src/templates.ts';
import { parseEnvFile } from '../src/checks.ts';
import { buildPlans } from '../src/init.ts';

describe('templates', () => {
  it('generatePairingCode is prefixed', () => {
    expect(generatePairingCode()).toMatch(/^aegis-[0-9a-f]+$/);
  });

  it('config uses key_ref not secrets', () => {
    const json = generateConfig({
      dataDir: './data',
      llmBaseUrl: 'http://localhost:11434/v1',
      llmModel: 'm',
      qLlmBaseUrl: 'http://localhost:11434/v1',
      qLlmModel: 'm',
      pairingCode: 'aegis-deadbeef',
    });
    expect(json).toContain('"key_ref": "AEGIS_P_LLM_KEY"');
    expect(json).not.toContain('bot_token":');
  });
});

describe('buildPlans', () => {
  it('includes broker token when key provided', () => {
    const plans = buildPlans('/tmp/a', {
      dataDir: './data',
      llmBaseUrl: 'u',
      llmModel: 'm',
      qLlmBaseUrl: 'u',
      qLlmModel: 'm',
      pairingCode: 'aegis-abc',
    }, 'secret-key');
    expect(plans.some((p) => p.path.endsWith('token.txt') && p.mode === 0o600)).toBe(true);
  });
});

describe('parseEnvFile', () => {
  it('parses simple env', () => {
    expect(parseEnvFile('A=1\n# c\nB=two')).toEqual({ A: '1', B: 'two' });
  });
});
