/**
 * Slack message classification (Sprint 31): DM-only, pairing, /approve.
 */
export type SlackClassified =
  | { kind: 'owner_text'; channelId: string; userId: string; text: string }
  | { kind: 'pair_attempt'; channelId: string; userId: string; code: string }
  | { kind: 'approve_attempt'; channelId: string; token: string; totpCode?: string }
  | { kind: 'stranger' }
  | { kind: 'ignored' };

const PAIR_RE = /^\/pair\s+(\S+)$/;
const APPROVE_RE = /^\/approve\s+(\S+)(?:\s+(\d{6}))?$/;

export interface SlackMessage {
  readonly channel: string;
  readonly user: string;
  readonly text: string;
  readonly channel_type?: string;
  readonly bot_id?: string;
  readonly subtype?: string;
}

export function classifySlackMessage(
  msg: SlackMessage,
  ownerId: string | undefined,
): SlackClassified {
  if (msg.channel_type !== 'im' || msg.bot_id || msg.subtype) return { kind: 'ignored' };
  const text = msg.text.trim();
  const pair = PAIR_RE.exec(text);
  if (pair?.[1]) {
    return { kind: 'pair_attempt', channelId: msg.channel, userId: msg.user, code: pair[1] };
  }
  if (ownerId !== undefined && msg.user === ownerId) {
    const approve = APPROVE_RE.exec(text);
    if (approve?.[1]) {
      return {
        kind: 'approve_attempt',
        channelId: msg.channel,
        token: approve[1],
        ...(approve[2] ? { totpCode: approve[2] } : {}),
      };
    }
    if (text.length > 0) {
      return { kind: 'owner_text', channelId: msg.channel, userId: msg.user, text };
    }
  }
  if (ownerId === undefined || msg.user !== ownerId) return { kind: 'stranger' };
  return { kind: 'ignored' };
}
