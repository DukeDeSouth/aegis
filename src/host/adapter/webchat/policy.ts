/**
 * WebChat inbound text classification (Sprint 29).
 */
export type WebchatClassified =
  | { kind: 'owner_text'; text: string }
  | { kind: 'approve_attempt'; token: string; totpCode?: string }
  | { kind: 'ignored' };

const APPROVE_RE = /^\/approve\s+(\S+)(?:\s+(\d{6}))?$/;

export function classifyWebchatText(text: string): WebchatClassified {
  const trimmed = text.trim();
  const approve = APPROVE_RE.exec(trimmed);
  if (approve?.[1]) {
    return {
      kind: 'approve_attempt',
      token: approve[1],
      ...(approve[2] ? { totpCode: approve[2] } : {}),
    };
  }
  if (trimmed.length > 0) return { kind: 'owner_text', text: trimmed };
  return { kind: 'ignored' };
}
