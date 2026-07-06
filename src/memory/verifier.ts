/**
 * Детерминированная проверка знаний: auto-corroborate без владельца (Sprint 6).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { KnowledgeStore } from './knowledge.ts';
import { PromotionGate } from './promotion.ts';
import type { MemoryProvenance } from './types.ts';

const AUTO_CORROBORATE_PROVENANCES: MemoryProvenance[] = ['owner', 'orchestrator'];

export interface KnowledgeVerifierOptions {
  promotion?: PromotionGate;
}

export class KnowledgeVerifier {
  private readonly db: Database.Database;
  private readonly knowledge: KnowledgeStore;
  private readonly promotion: PromotionGate;

  constructor(
    db: Database.Database,
    knowledge: KnowledgeStore,
    opts: KnowledgeVerifierOptions = {},
  ) {
    this.db = db;
    this.knowledge = knowledge;
    this.promotion = opts.promotion ?? new PromotionGate(db);
  }

  /** Повторное чтение body из БД; стабильный hash + trusted provenance → corroborated. */
  tryAutoCorroborate(knowledgeId: number): boolean {
    const row = this.knowledge.getById(knowledgeId);
    if (row?.epistemicStatus !== 'unverified') return false;
    if (!AUTO_CORROBORATE_PROVENANCES.includes(row.provenance)) return false;

    const reread = this.db.prepare('SELECT body FROM knowledge WHERE id = ?').get(knowledgeId) as
      { body: string } | undefined;
    if (reread?.body !== row.body) return false;

    const hash = stableBodyHash(row.body);
    if (!hash) return false;

    this.promotion.corroborateWithEvidence(
      knowledgeId,
      'reproduced_observation',
      `stable body hash ${hash}`,
      'auto_corroborate',
    );
    return true;
  }
}

function stableBodyHash(body: string): string {
  const normalized = body.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return '';
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
