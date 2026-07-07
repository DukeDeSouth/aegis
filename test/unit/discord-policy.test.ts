import { describe, expect, it } from 'vitest';
import { classifyDiscordMessage } from '../../src/host/adapter/discord/policy.ts';

const base = {
  id: '1',
  channel_id: 'ch1',
  author: { id: 'user-1' },
  content: '',
};

describe('classifyDiscordMessage', () => {
  it('ignores bot and guild messages', () => {
    expect(
      classifyDiscordMessage({ ...base, author: { id: 'b', bot: true }, content: 'hi' }, undefined),
    ).toEqual({ kind: 'ignored' });
    expect(
      classifyDiscordMessage({ ...base, guild_id: 'g1', content: 'hi' }, undefined),
    ).toEqual({ kind: 'ignored' });
  });

  it('pair attempt before owner', () => {
    const c = classifyDiscordMessage({ ...base, content: '/pair secret-code' }, undefined);
    expect(c).toEqual({
      kind: 'pair_attempt',
      channelId: 'ch1',
      authorId: 'user-1',
      code: 'secret-code',
    });
  });

  it('owner text and approve when paired', () => {
    expect(classifyDiscordMessage({ ...base, content: 'hello' }, 'user-1')).toEqual({
      kind: 'owner_text',
      channelId: 'ch1',
      authorId: 'user-1',
      text: 'hello',
    });
    expect(classifyDiscordMessage({ ...base, content: '/approve tok123' }, 'user-1')).toEqual({
      kind: 'approve_attempt',
      channelId: 'ch1',
      token: 'tok123',
    });
  });

  it('stranger when not owner', () => {
    expect(classifyDiscordMessage({ ...base, content: 'hi' }, 'other')).toEqual({ kind: 'stranger' });
    expect(classifyDiscordMessage({ ...base, content: 'hi' }, undefined)).toEqual({ kind: 'stranger' });
  });
});
