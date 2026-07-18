import { describe, expect, it } from 'vitest';
import { createMessageDedupe } from '../../packages/aegis-webchat/public/dedupe.js';

describe('webchat message dedupe', () => {
  it('blocks duplicate by text after local send without id', () => {
    const d = createMessageDedupe();
    d.remember('user', 'как дела?', undefined);
    expect(d.isDuplicate('user', 'как дела?', 55)).toBe(true);
  });

  it('blocks duplicate by id after history load', () => {
    const d = createMessageDedupe();
    d.remember('bot', 'Привет!', 50);
    expect(d.isDuplicate('bot', 'Привет!', 50)).toBe(true);
    expect(d.isDuplicate('bot', 'Привет!', undefined)).toBe(true);
  });

  it('blocks poll then tail-sync bot with same text', () => {
    const d = createMessageDedupe();
    d.remember('bot', 'Ответ', undefined);
    expect(d.isDuplicate('bot', 'Ответ', 99)).toBe(true);
  });

  it('allows different messages with same role', () => {
    const d = createMessageDedupe();
    d.remember('user', 'привет', undefined);
    expect(d.isDuplicate('user', 'пока', undefined)).toBe(false);
  });

  it('clear resets state', () => {
    const d = createMessageDedupe();
    d.remember('user', 'x', 1);
    d.clear();
    expect(d.isDuplicate('user', 'x', 1)).toBe(false);
  });
});
