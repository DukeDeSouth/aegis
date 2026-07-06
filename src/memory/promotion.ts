/**
 * Promotion-гейт: evidence + UPDATE с журналом status_transitions (Sprint 6).
 * SQL-триггеры — последняя линия защиты (migrations/0001-memory.sql).
 */
import type Database from 'better-sqlite3';
import type { EpistemicStatus, EvidenceType } from './types.ts';

export const PROMOTION_GATES = ['auto_corroborate', 'owner_verify', 'refutation', 'decay'] as const;
export type PromotionGateType = (typeof PROMOTION_GATES)[number];

const MAX_EVIDENCE_PER_KNOWLEDGE = 20;

export interface PromotionGateOptions {
  now?: () => number;
}

export class PromotionGate {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: PromotionGateOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  addEvidence(
    knowledgeId: number,
    evidenceType: EvidenceType,
    summary: string,
    ref?: string,
  ): number {
    const count = this.db
      .prepare('SELECT COUNT(*) c FROM evidence WHERE knowledge_id = ?')
      .get(knowledgeId) as { c: number };
    if (count.c >= MAX_EVIDENCE_PER_KNOWLEDGE) {
      throw new Error(
        `evidence limit (${MAX_EVIDENCE_PER_KNOWLEDGE}) exceeded for knowledge ${knowledgeId}`,
      );
    }
    const ts = this.now();
    const res = this.db
      .prepare(
        `INSERT INTO evidence (knowledge_id, evidence_type, summary, ref, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(knowledgeId, evidenceType, summary, ref ?? null, ts);
    return Number(res.lastInsertRowid);
  }

  promote(
    knowledgeId: number,
    toStatus: EpistemicStatus,
    gate: PromotionGateType,
    evidenceId?: number,
  ): void {
    const row = this.db
      .prepare('SELECT epistemic_status FROM knowledge WHERE id = ?')
      .get(knowledgeId) as { epistemic_status: EpistemicStatus } | undefined;
    if (!row) throw new Error(`knowledge ${knowledgeId} not found`);

    const ts = this.now();
    this.db
      .prepare(`UPDATE knowledge SET epistemic_status = ?, updated_at = ? WHERE id = ?`)
      .run(toStatus, ts, knowledgeId);

    this.db
      .prepare(
        `INSERT INTO status_transitions (knowledge_id, from_status, to_status, gate, evidence_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(knowledgeId, row.epistemic_status, toStatus, gate, evidenceId ?? null, ts);
  }

  corroborateWithEvidence(
    knowledgeId: number,
    evidenceType: 'test_pass' | 'reproduced_observation',
    summary: string,
    gate: PromotionGateType = 'auto_corroborate',
  ): void {
    const evidenceId = this.addEvidence(knowledgeId, evidenceType, summary);
    this.promote(knowledgeId, 'corroborated', gate, evidenceId);
  }

  verifyByOwner(knowledgeId: number): void {
    const evidenceId = this.addEvidence(
      knowledgeId,
      'owner_confirmation',
      'owner verified via command',
    );
    this.promote(knowledgeId, 'verified', 'owner_verify', evidenceId);
  }

  ownerCorroborate(knowledgeId: number): void {
    const evidenceId = this.addEvidence(knowledgeId, 'test_pass', 'owner corroborated via command');
    this.promote(knowledgeId, 'corroborated', 'owner_verify', evidenceId);
  }

  refute(knowledgeId: number, gate: PromotionGateType, reason: string): void {
    const evidenceId = this.addEvidence(knowledgeId, 'external_source', reason);
    this.promote(knowledgeId, 'refuted', gate, evidenceId);
  }
}
