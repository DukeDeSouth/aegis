/**
 * Discord DM message classification (F10).
 */
export type DiscordClassified =
  | { kind: 'owner_text'; channelId: string; authorId: string; text: string }
  | { kind: 'pair_attempt'; channelId: string; authorId: string; code: string }
  | { kind: 'approve_attempt'; channelId: string; token: string }
  | { kind: 'stranger' }
  | { kind: 'ignored' };

const PAIR_RE = /^\/pair\s+(\S+)$/;
const APPROVE_RE = /^\/approve\s+(\S+)$/;

export interface DiscordMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly author: { id: string; bot?: boolean };
  readonly content: string;
  readonly guild_id?: string;
}

export function classifyDiscordMessage(
  msg: DiscordMessage,
  ownerId: string | undefined,
): DiscordClassified {
  if (msg.author.bot || msg.guild_id !== undefined) return { kind: 'ignored' };
  const pair = PAIR_RE.exec(msg.content.trim());
  if (pair?.[1]) {
    return { kind: 'pair_attempt', channelId: msg.channel_id, authorId: msg.author.id, code: pair[1] };
  }
  if (ownerId !== undefined && msg.author.id === ownerId) {
    const approve = APPROVE_RE.exec(msg.content.trim());
    if (approve?.[1]) return { kind: 'approve_attempt', channelId: msg.channel_id, token: approve[1] };
    if (msg.content.length > 0) {
      return { kind: 'owner_text', channelId: msg.channel_id, authorId: msg.author.id, text: msg.content };
    }
  }
  if (ownerId === undefined || msg.author.id !== ownerId) return { kind: 'stranger' };
  return { kind: 'ignored' };
}
