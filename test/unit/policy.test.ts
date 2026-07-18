import { describe, expect, it } from 'vitest';
import { classifyUpdate } from '../../src/host/adapter/policy.ts';
import type { TgUpdate } from '../../src/host/adapter/telegram-client.ts';

const OWNER = 42;

function update(msg: Partial<TgUpdate['message']> & object): TgUpdate {
  return { update_id: 1, message: { message_id: 1, ...msg } };
}

describe('classifyUpdate (deny-by-default)', () => {
  it('прямой текст владельца → owner_text', () => {
    const c = classifyUpdate(
      update({ from: { id: OWNER }, chat: { id: 10 }, text: 'привет' }),
      OWNER,
    );
    expect(c).toEqual({ kind: 'owner_text', chatId: 10, text: 'привет' });
  });

  it('чужой отправитель → stranger (тихий deny)', () => {
    const c = classifyUpdate(update({ from: { id: 999 }, chat: { id: 10 }, text: 'hi' }), OWNER);
    expect(c).toEqual({ kind: 'stranger' });
  });

  it('owner не задан: обычный текст → stranger, /pair — единственная дверь', () => {
    expect(
      classifyUpdate(update({ from: { id: 5 }, chat: { id: 10 }, text: 'hi' }), undefined).kind,
    ).toBe('stranger');
    expect(
      classifyUpdate(
        update({ from: { id: 5 }, chat: { id: 10 }, text: '/pair abc123' }),
        undefined,
      ),
    ).toEqual({ kind: 'pair_attempt', chatId: 10, fromId: 5, code: 'abc123' });
  });

  it('/pair без кода — не pair_attempt (падает в deny-ветки)', () => {
    const c = classifyUpdate(
      update({ from: { id: 5 }, chat: { id: 10 }, text: '/pair' }),
      undefined,
    );
    expect(c.kind).toBe('stranger');
  });

  it('пересланное сообщение от владельца → untrusted/forwarded (карантин S7)', () => {
    const c = classifyUpdate(
      update({
        from: { id: OWNER },
        chat: { id: 10 },
        text: 'fwd',
        forward_origin: { type: 'user' },
      }),
      OWNER,
    );
    expect(c).toEqual({ kind: 'untrusted', chatId: 10, reason: 'forwarded' });
  });

  it('голосовое сообщение от владельца → owner_voice', () => {
    const c = classifyUpdate(
      update({
        from: { id: OWNER },
        chat: { id: 10 },
        voice: { file_id: 'f', file_unique_id: 'u', duration: 5 },
      }),
      OWNER,
    );
    expect(c).toEqual({
      kind: 'owner_voice',
      chatId: 10,
      voice: { file_id: 'f', file_unique_id: 'u', duration: 5 },
    });
  });

  it('не-текст от владельца (фото/стикер) → untrusted/non_text', () => {
    const c = classifyUpdate(update({ from: { id: OWNER }, chat: { id: 10 } }), OWNER);
    expect(c).toEqual({ kind: 'untrusted', chatId: 10, reason: 'non_text' });
  });

  it('update без message (edited_message и пр.) → ignored', () => {
    expect(classifyUpdate({ update_id: 1 }, OWNER).kind).toBe('ignored');
  });

  it('message без from.id или chat.id → ignored (нет позитивной идентификации)', () => {
    expect(classifyUpdate(update({ chat: { id: 10 }, text: 'x' }), OWNER).kind).toBe('ignored');
    expect(classifyUpdate(update({ from: { id: OWNER }, text: 'x' }), OWNER).kind).toBe('ignored');
  });

  it('owner undefined и from.id отсутствует: не owner_text (строгое равенство чисел)', () => {
    const c = classifyUpdate(update({ chat: { id: 10 }, text: 'x' }), undefined);
    expect(c.kind).toBe('ignored');
  });

  it('/pair от чужого при спаренном канале остаётся pair_attempt — решает обработчик', () => {
    const c = classifyUpdate(
      update({ from: { id: 999 }, chat: { id: 10 }, text: '/pair guess' }),
      OWNER,
    );
    expect(c.kind).toBe('pair_attempt');
  });

  it('/approve от владельца → approve_attempt', () => {
    const c = classifyUpdate(
      update({ from: { id: OWNER }, chat: { id: 10 }, text: '/approve abcd1234' }),
      OWNER,
    );
    expect(c).toEqual({ kind: 'approve_attempt', chatId: 10, token: 'abcd1234' });
  });

  it('/approve от чужого → stranger', () => {
    const c = classifyUpdate(
      update({ from: { id: 999 }, chat: { id: 10 }, text: '/approve abcd1234' }),
      OWNER,
    );
    expect(c.kind).toBe('stranger');
  });
});
