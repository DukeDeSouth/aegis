export type ChannelKind = 'telegram' | 'discord';
export type ApproveChannel = ChannelKind | 'totp';

export function channelFromSession(sessionId: string): ChannelKind | null {
  if (sessionId.startsWith('tg:')) return 'telegram';
  if (sessionId.startsWith('discord:')) return 'discord';
  return null;
}

export function otherChannel(ch: ChannelKind): ChannelKind {
  return ch === 'telegram' ? 'discord' : 'telegram';
}

export function channelLabel(ch: ApproveChannel): string {
  if (ch === 'telegram') return 'Telegram';
  if (ch === 'discord') return 'Discord';
  return 'TOTP';
}
