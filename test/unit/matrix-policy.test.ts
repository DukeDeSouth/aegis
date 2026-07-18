import { describe, expect, it } from 'vitest';
import { classifyMatrixMessage } from '../../src/host/adapter/matrix/policy.ts';

const base = {
  roomId: '!room:example.org',
  sender: '@user:example.org',
  body: '',
  isDirect: true,
};

describe('classifyMatrixMessage', () => {
  it('ignores non-DM rooms', () => {
    expect(classifyMatrixMessage({ ...base, isDirect: false, body: 'hi' }, undefined)).toEqual({
      kind: 'ignored',
    });
  });

  it('pair attempt before owner', () => {
    expect(classifyMatrixMessage({ ...base, body: '/pair secret-code' }, undefined)).toEqual({
      kind: 'pair_attempt',
      roomId: base.roomId,
      sender: base.sender,
      code: 'secret-code',
    });
  });

  it('owner text and approve when paired', () => {
    expect(classifyMatrixMessage({ ...base, body: 'hello' }, base.sender)).toEqual({
      kind: 'owner_text',
      roomId: base.roomId,
      sender: base.sender,
      text: 'hello',
    });
    expect(classifyMatrixMessage({ ...base, body: '/approve tok123' }, base.sender)).toEqual({
      kind: 'approve_attempt',
      roomId: base.roomId,
      token: 'tok123',
    });
    expect(classifyMatrixMessage({ ...base, body: '/approve tok123 123456' }, base.sender)).toEqual({
      kind: 'approve_attempt',
      roomId: base.roomId,
      token: 'tok123',
      totpCode: '123456',
    });
  });

  it('stranger when not owner', () => {
    expect(classifyMatrixMessage({ ...base, body: 'hi' }, '@other:example.org')).toEqual({
      kind: 'stranger',
    });
    expect(classifyMatrixMessage({ ...base, body: 'hi' }, undefined)).toEqual({ kind: 'stranger' });
  });
});
