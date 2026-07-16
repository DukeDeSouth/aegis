import type { PendingRecord } from './pending.ts';
import { channelFromSession, type ApproveChannel } from './channels.ts';
import { verifyTotp } from './totp.ts';

export type ApprovalReject = 'totp_invalid' | 'wrong_channel';

export function checkPendingApproval(
  record: PendingRecord,
  approverSessionId: string,
  totpCode: string | undefined,
  totpSecret: string | undefined,
): ApprovalReject | null {
  const required = record.requiredChannel;
  if (required === null) return null;
  if (required === 'totp') {
    return totpSecret !== undefined &&
      totpCode !== undefined &&
      verifyTotp(totpCode, totpSecret)
      ? null
      : 'totp_invalid';
  }
  return channelFromSession(approverSessionId) === required ? null : 'wrong_channel';
}

export function approvalRejectHint(required: ApproveChannel, token: string): string {
  if (required === 'totp') return `Confirm with TOTP: /approve ${token} <6-digit-code>`;
  const ch = required === 'telegram' ? 'Telegram' : 'Discord';
  return `Wrong channel. Confirm from ${ch}: /approve ${token}`;
}
