import { describe, expect, it } from 'vitest';
import { extractUntrustedBody } from '../../src/host/adapter/policy.ts';
import type { TgMessage } from '../../src/host/adapter/telegram-client.ts';

describe('extractUntrustedBody', () => {
  it('forward с текстом → текст', () => {
    const msg: TgMessage = {
      message_id: 1,
      text: '  letter body  ',
      forward_origin: { type: 'user' },
    };
    expect(extractUntrustedBody(msg)).toBe('letter body');
  });

  it('forward без текста → placeholder', () => {
    const msg: TgMessage = { message_id: 1, forward_origin: { type: 'channel' } };
    expect(extractUntrustedBody(msg)).toBe('[forwarded message without text]');
  });

  it('вложение с caption → caption', () => {
    const msg: TgMessage = { message_id: 1, caption: '  photo caption ' };
    expect(extractUntrustedBody(msg)).toBe('photo caption');
  });

  it('non-text без caption → placeholder', () => {
    const msg: TgMessage = { message_id: 1 };
    expect(extractUntrustedBody(msg)).toBe('[non-text attachment]');
  });
});
