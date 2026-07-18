/**
 * Matrix message classification (Sprint 30): DM-only, pairing, /approve.
 */
export type MatrixClassified =
  | { kind: 'owner_text'; roomId: string; sender: string; text: string }
  | { kind: 'pair_attempt'; roomId: string; sender: string; code: string }
  | { kind: 'approve_attempt'; roomId: string; token: string; totpCode?: string }
  | { kind: 'stranger' }
  | { kind: 'ignored' };

const PAIR_RE = /^\/pair\s+(\S+)$/;
const APPROVE_RE = /^\/approve\s+(\S+)(?:\s+(\d{6}))?$/;

export interface MatrixMessage {
  readonly roomId: string;
  readonly sender: string;
  readonly body: string;
  readonly isDirect: boolean;
}

export function classifyMatrixMessage(
  msg: MatrixMessage,
  ownerId: string | undefined,
): MatrixClassified {
  if (!msg.isDirect) return { kind: 'ignored' };
  const text = msg.body.trim();
  const pair = PAIR_RE.exec(text);
  if (pair?.[1]) {
    return { kind: 'pair_attempt', roomId: msg.roomId, sender: msg.sender, code: pair[1] };
  }
  if (ownerId !== undefined && msg.sender === ownerId) {
    const approve = APPROVE_RE.exec(text);
    if (approve?.[1]) {
      return {
        kind: 'approve_attempt',
        roomId: msg.roomId,
        token: approve[1],
        ...(approve[2] ? { totpCode: approve[2] } : {}),
      };
    }
    if (text.length > 0) {
      return { kind: 'owner_text', roomId: msg.roomId, sender: msg.sender, text };
    }
  }
  if (ownerId === undefined || msg.sender !== ownerId) return { kind: 'stranger' };
  return { kind: 'ignored' };
}
