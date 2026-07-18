/**
 * Контракты памяти (docs/MEMORY_SCHEMA.md, docs/LEARNING_LOOP.md).
 * Значения enum'ов дублируют CHECK-ограничения миграции 0001-memory.sql —
 * расхождение ловится интеграционным тестом миграций.
 */

export const EPISTEMIC_STATUSES = ['unverified', 'corroborated', 'verified', 'refuted'] as const;
export type EpistemicStatus = (typeof EPISTEMIC_STATUSES)[number];

export const KNOWLEDGE_KINDS = ['fact', 'procedure', 'skill'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const MEMORY_PROVENANCES = [
  'owner',
  'orchestrator',
  'quarantine',
  'background',
  'consolidation',
] as const;
export type MemoryProvenance = (typeof MEMORY_PROVENANCES)[number];

export const EVIDENCE_TYPES = [
  'test_pass',
  'reproduced_observation',
  'owner_confirmation',
  'external_source',
  'llm_proposal',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
