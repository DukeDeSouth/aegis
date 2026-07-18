/**
 * WebChat pairing brute-force lockout (Sprint 41, THREAT_MODEL V9).
 */
import type { AuditLog } from '../../audit/log.ts';
import type { ChannelState } from '../state.ts';

export const PAIR_MAX_FAILS = 5;
export const PAIR_BACKOFF_BASE_MS = 60_000;
export const PAIR_BACKOFF_MAX_MS = 15 * 60_000;

export function pairingBackoffMs(strike: number): number {
  return Math.min(PAIR_BACKOFF_BASE_MS * 2 ** Math.max(0, strike - 1), PAIR_BACKOFF_MAX_MS);
}

export function isPairingLockedOut(state: ChannelState, now = Date.now()): boolean {
  const until = state.getWebchatPairLockoutUntil();
  return until !== undefined && until > now;
}

/** Returns true when lockout was triggered by this failure. */
export function recordPairingFailure(
  state: ChannelState,
  audit: AuditLog,
  actor: string,
  now = Date.now(),
): boolean {
  const fails = state.getWebchatPairFailCount() + 1;
  state.setWebchatPairFailCount(fails);
  if (fails < PAIR_MAX_FAILS) return false;

  const strike = state.getWebchatPairLockoutStrikes() + 1;
  const backoffMs = pairingBackoffMs(strike);
  state.setWebchatPairLockoutStrikes(strike);
  state.setWebchatPairLockoutUntil(now + backoffMs);
  state.setWebchatPairFailCount(0);
  audit.append({
    actor,
    action: 'pairing.lockout',
    decision: 'deny',
    payload: { strike, backoffMs, until: now + backoffMs },
  });
  return true;
}

export function clearPairingLockout(state: ChannelState): void {
  state.setWebchatPairFailCount(0);
  state.setWebchatPairLockoutUntil(0);
}
