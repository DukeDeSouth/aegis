import type { ApproveChannel, ChannelKind } from './channels.ts';
import { channelFromSession, channelLabel, otherChannel } from './channels.ts';
import type { ActionClass } from './types.ts';

export interface SecondFactorConfig {
  readonly enabled: boolean;
  readonly modes: readonly ('cross_channel' | 'totp')[];
  readonly action_classes: readonly ActionClass[];
}

export interface PairedChannels {
  readonly telegram: boolean;
  readonly discord: boolean;
}

export function resolveRequiredChannel(
  cfg: SecondFactorConfig | undefined,
  actionClass: ActionClass,
  originSessionId: string,
  paired: PairedChannels,
  totpConfigured: boolean,
): ApproveChannel | null {
  if (!cfg?.enabled || !cfg.action_classes.includes(actionClass)) return null;
  const origin = channelFromSession(originSessionId);
  if (cfg.modes.includes('cross_channel') && paired.telegram && paired.discord && origin) {
    return otherChannel(origin);
  }
  if (cfg.modes.includes('totp') && totpConfigured) return 'totp';
  return null;
}

export function formatApproveHint(required: ApproveChannel | null, token: string): string {
  if (required === null) return `Confirm with: /approve ${token}`;
  if (required === 'totp') return `Confirm with TOTP: /approve ${token} <6-digit-code>`;
  return `Confirm from ${channelLabel(required)}: /approve ${token}`;
}
