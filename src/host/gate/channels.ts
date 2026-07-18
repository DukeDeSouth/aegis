export type ChannelKind = 'telegram' | 'discord' | 'webchat' | 'matrix' | 'slack';
export type ApproveChannel = ChannelKind | 'totp';

export function channelFromSession(sessionId: string): ChannelKind | null {
  if (sessionId.startsWith('tg:')) return 'telegram';
  if (sessionId.startsWith('discord:')) return 'discord';
  if (sessionId.startsWith('webchat:')) return 'webchat';
  if (sessionId.startsWith('matrix:')) return 'matrix';
  if (sessionId.startsWith('slack:')) return 'slack';
  return null;
}

/** @deprecated use pickAlternateChannel for multi-channel 2FA */
export function otherChannel(ch: ChannelKind): ChannelKind {
  if (ch === 'telegram') return 'discord';
  if (ch === 'discord') return 'telegram';
  if (ch === 'matrix') return 'telegram';
  if (ch === 'slack') return 'telegram';
  return 'webchat';
}

export function pickAlternateChannel(
  origin: ChannelKind,
  paired: {
    readonly telegram: boolean;
    readonly discord: boolean;
    readonly webchat: boolean;
    readonly matrix: boolean;
    readonly slack: boolean;
  },
): ChannelKind | null {
  if (origin !== 'telegram' && paired.telegram) return 'telegram';
  if (origin !== 'discord' && paired.discord) return 'discord';
  if (origin !== 'webchat' && paired.webchat) return 'webchat';
  if (origin !== 'matrix' && paired.matrix) return 'matrix';
  if (origin !== 'slack' && paired.slack) return 'slack';
  return null;
}

export function channelLabel(ch: ApproveChannel): string {
  if (ch === 'telegram') return 'Telegram';
  if (ch === 'discord') return 'Discord';
  if (ch === 'webchat') return 'WebChat';
  if (ch === 'matrix') return 'Matrix';
  if (ch === 'slack') return 'Slack';
  return 'TOTP';
}
