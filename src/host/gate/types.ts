/**
 * Контракты gate engine (docs/SECURITY_MODEL.md, ADR-0007).
 * Классы действий — общий словарь ядра: их же использует manifest.json навыка
 * и колонка action_class в audit_log.
 */

export const ACTION_CLASSES = ['read-only', 'reversible', 'irreversible'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export type GateVerdict = 'allow' | 'deny' | 'confirm_required';

export interface GateDecision {
  verdict: GateVerdict;
  actionClass: ActionClass;
  /** Причина решения — обязательна: попадает в audit_log. */
  reason: string;
}
