import { describe, expect, it } from 'vitest';
import { channelFromSession, otherChannel } from '../../src/host/gate/channels.ts';
import { formatApproveHint, resolveRequiredChannel } from '../../src/host/gate/second-factor.ts';

const SF = { enabled: true, modes: ['cross_channel'] as const, action_classes: ['irreversible'] as const };
const BOTH = { telegram: true, discord: true, webchat: false, matrix: false, slack: false };

describe('second-factor', () => {
  it('cross-channel: tg origin requires discord', () => {
    expect(resolveRequiredChannel(SF, 'irreversible', 'tg:1', BOTH, false)).toBe('discord');
    expect(resolveRequiredChannel(SF, 'irreversible', 'discord:9', BOTH, false)).toBe('telegram');
  });

  it('webchat + telegram cross-channel', () => {
    const paired = { telegram: true, discord: false, webchat: true, matrix: false, slack: false };
    expect(resolveRequiredChannel(SF, 'irreversible', 'webchat:local', paired, false)).toBe('telegram');
    expect(resolveRequiredChannel(SF, 'irreversible', 'tg:1', paired, false)).toBe('webchat');
  });

  it('matrix + telegram cross-channel', () => {
    const paired = { telegram: true, discord: false, webchat: false, matrix: true, slack: false };
    expect(resolveRequiredChannel(SF, 'irreversible', 'matrix:!r:ex', paired, false)).toBe('telegram');
    expect(resolveRequiredChannel(SF, 'irreversible', 'tg:1', paired, false)).toBe('matrix');
  });

  it('slack + telegram cross-channel', () => {
    const paired = { telegram: true, discord: false, webchat: false, matrix: false, slack: true };
    expect(resolveRequiredChannel(SF, 'irreversible', 'slack:D1', paired, false)).toBe('telegram');
    expect(resolveRequiredChannel(SF, 'irreversible', 'tg:1', paired, false)).toBe('slack');
  });

  it('disabled or single channel → null', () => {
    expect(resolveRequiredChannel(undefined, 'irreversible', 'tg:1', BOTH, false)).toBeNull();
    expect(
      resolveRequiredChannel(SF, 'irreversible', 'tg:1', { telegram: true, discord: false, webchat: false, matrix: false, slack: false }, false),
    ).toBeNull();
  });

  it('formatApproveHint', () => {
    expect(formatApproveHint('discord', 'abc')).toContain('Discord');
    expect(formatApproveHint('webchat', 'abc')).toContain('WebChat');
    expect(formatApproveHint('matrix', 'abc')).toContain('Matrix');
    expect(formatApproveHint('slack', 'abc')).toContain('Slack');
    expect(formatApproveHint(null, 'abc')).toContain('/approve abc');
  });

  it('channel helpers', () => {
    expect(channelFromSession('tg:1')).toBe('telegram');
    expect(channelFromSession('webchat:local')).toBe('webchat');
    expect(channelFromSession('matrix:!r:ex')).toBe('matrix');
    expect(channelFromSession('slack:D1')).toBe('slack');
    expect(otherChannel('telegram')).toBe('discord');
  });
});
