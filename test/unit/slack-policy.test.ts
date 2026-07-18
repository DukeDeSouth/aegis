import { describe, expect, it } from 'vitest';
import { classifySlackMessage } from '../../src/host/adapter/slack/policy.ts';

const base = {
  channel: 'D0123ABCD',
  user: 'UOWNER1',
  text: '',
  channel_type: 'im' as const,
};

describe('classifySlackMessage', () => {
  it('ignores non-im and bot messages', () => {
    expect(classifySlackMessage({ ...base, channel_type: 'channel', text: 'hi' }, undefined)).toEqual({
      kind: 'ignored',
    });
    expect(
      classifySlackMessage({ ...base, bot_id: 'B1', text: 'hi' }, undefined),
    ).toEqual({ kind: 'ignored' });
    expect(
      classifySlackMessage({ ...base, subtype: 'message_changed', text: 'hi' }, undefined),
    ).toEqual({ kind: 'ignored' });
  });

  it('pair attempt before owner', () => {
    expect(classifySlackMessage({ ...base, text: '/pair secret-code' }, undefined)).toEqual({
      kind: 'pair_attempt',
      channelId: base.channel,
      userId: base.user,
      code: 'secret-code',
    });
  });

  it('owner text and approve when paired', () => {
    expect(classifySlackMessage({ ...base, text: 'hello' }, base.user)).toEqual({
      kind: 'owner_text',
      channelId: base.channel,
      userId: base.user,
      text: 'hello',
    });
    expect(classifySlackMessage({ ...base, text: '/approve tok123' }, base.user)).toEqual({
      kind: 'approve_attempt',
      channelId: base.channel,
      token: 'tok123',
    });
  });

  it('stranger when not owner', () => {
    expect(classifySlackMessage({ ...base, text: 'hi' }, 'UOTHER')).toEqual({ kind: 'stranger' });
    expect(classifySlackMessage({ ...base, text: 'hi' }, undefined)).toEqual({ kind: 'stranger' });
  });
});
