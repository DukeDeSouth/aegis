import { describe, expect, it } from 'vitest';
import { channelFromSession, otherChannel } from '../../src/host/gate/channels.ts';
import { formatApproveHint, resolveRequiredChannel } from '../../src/host/gate/second-factor.ts';

const SF = { enabled: true, modes: ['cross_channel'] as const, action_classes: ['irreversible'] as const };
const BOTH = { telegram: true, discord: true };

describe('second-factor', () => {
  it('cross-channel: tg origin requires discord', () => {
    expect(resolveRequiredChannel(SF, 'irreversible', 'tg:1', BOTH, false)).toBe('discord');
    expect(resolveRequiredChannel(SF, 'irreversible', 'discord:9', BOTH, false)).toBe('telegram');
  });

  it('disabled or single channel → null', () => {
    expect(resolveRequiredChannel(undefined, 'irreversible', 'tg:1', BOTH, false)).toBeNull();
    expect(resolveRequiredChannel(SF, 'irreversible', 'tg:1', { telegram: true, discord: false }, false)).toBeNull();
  });

  it('formatApproveHint', () => {
    expect(formatApproveHint('discord', 'abc')).toContain('Discord');
    expect(formatApproveHint(null, 'abc')).toContain('/approve abc');
  });

  it('channel helpers', () => {
    expect(channelFromSession('tg:1')).toBe('telegram');
    expect(otherChannel('telegram')).toBe('discord');
  });
});
