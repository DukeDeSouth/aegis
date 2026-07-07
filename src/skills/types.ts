/**
 * Типы навыков (ADR-0007): manifest v1 + capability-реестр.
 */
import type { ActionClass } from '../host/gate/types.ts';

export const CAPABILITY_REGISTRY = [
  'email.read',
  'email.draft',
  'web.fetch',
  'files.read',
  'files.write',
  'messages.send',
  'schedule.manage',
  'memory.read',
  'memory.propose',
] as const;

export type CapabilityId = (typeof CAPABILITY_REGISTRY)[number];

/** Capability, требующие сетевого доступа (семантика validate). */
export const NETWORK_REQUIRED_CAPABILITIES = new Set<CapabilityId>([
  'email.read',
  'email.draft',
  'web.fetch',
  'messages.send',
]);

export interface SkillManifest {
  schema_version: 1;
  name: string;
  version: string;
  needs: CapabilityId[];
  network: 'none' | string[];
  action_class: ActionClass;
  code: boolean;
  entrypoints: string[];
  /** F7: внешний импорт — не в prompt до /skill-approve. */
  requires_review?: boolean | undefined;
}

export interface SkillSummary {
  name: string;
  description: string;
  code: boolean;
  actionClass: ActionClass;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface DryRunResult {
  skillName: string;
  exitCode: number;
  timedOut: boolean;
  corroborated: boolean;
  knowledgeId?: number;
}

export interface InstallResult {
  name: string;
  ref: string;
  knowledgeId: number;
  requiresReview?: boolean;
}
