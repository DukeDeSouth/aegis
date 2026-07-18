import { describe, expect, it } from 'vitest';
import { classifyWebchatText } from '../../src/host/adapter/webchat/policy.ts';

describe('webchat policy', () => {
  it('owner text', () => {
    expect(classifyWebchatText('hello')).toEqual({ kind: 'owner_text', text: 'hello' });
  });

  it('/approve with optional totp', () => {
    expect(classifyWebchatText('/approve tok123')).toEqual({
      kind: 'approve_attempt',
      token: 'tok123',
    });
    expect(classifyWebchatText('/approve tok123 654321')).toEqual({
      kind: 'approve_attempt',
      token: 'tok123',
      totpCode: '654321',
    });
  });

  it('empty ignored', () => {
    expect(classifyWebchatText('   ')).toEqual({ kind: 'ignored' });
  });
});
