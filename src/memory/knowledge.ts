/**
 * Семантическая память: знания со статусами и provenance (docs/LEARNING_LOOP.md).
 * Promotion — Sprint 6; здесь insert + inject filter.
 */
import type Database from 'better-sqlite3';
import type { EpistemicStatus, KnowledgeKind, MemoryProvenance } from './types.ts';

export interface KnowledgeRow {
  id: number;
  kind: KnowledgeKind;
  title: string;
  body: string;
  epistemicStatus: EpistemicStatus;
  provenance: MemoryProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface InsertKnowledgeInput {
  kind?: KnowledgeKind;
  title: string;
  body: string;
  provenance: MemoryProvenance;
  epistemicStatus?: EpistemicStatus;
  skillRef?: string;
}

export interface KnowledgeStoreOptions {
  now?: () => number;
  injectLimit?: number;
}

const DEFAULT_INJECT_LIMIT = 10;
const MAX_BODY_INJECT = 500;

export class KnowledgeStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly injectLimit: number;

  constructor(db: Database.Database, opts: KnowledgeStoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.injectLimit = opts.injectLimit ?? DEFAULT_INJECT_LIMIT;
  }

  insert(input: InsertKnowledgeInput): number {
    const ts = this.now();
    const status = input.epistemicStatus ?? 'unverified';
    const kind = input.kind ?? 'fact';
    const res = this.db
      .prepare(
        `INSERT INTO knowledge (kind, title, body, epistemic_status, provenance, skill_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, input.title, input.body, status, input.provenance, input.skillRef ?? null, ts, ts);
    return Number(res.lastInsertRowid);
  }

  insertSkill(input: Omit<InsertKnowledgeInput, 'kind'> & { skillRef: string }): number {
    return this.insert({ ...input, kind: 'skill' });
  }

  findSkillKnowledgeId(title: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM knowledge WHERE kind = 'skill' AND title = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(title) as { id: number } | undefined;
    return row?.id;
  }

  /** corroborated и verified — для системного контекста (не unverified/refuted). */
  listForInjection(): KnowledgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, title, body, epistemic_status, provenance, created_at, updated_at
         FROM knowledge
         WHERE epistemic_status IN ('corroborated', 'verified')
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(this.injectLimit) as RawKnowledge[];
    return rows.map(toRow);
  }

  bumpUsage(id: number): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE knowledge SET use_count = use_count + 1, last_used_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(ts, ts, id);
  }

  getById(id: number): KnowledgeRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, kind, title, body, epistemic_status, provenance, created_at, updated_at
         FROM knowledge WHERE id = ?`,
      )
      .get(id) as RawKnowledge | undefined;
    return row ? toRow(row) : undefined;
  }

  listUnverified(): KnowledgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, title, body, epistemic_status, provenance, created_at, updated_at
         FROM knowledge WHERE epistemic_status = 'unverified'
         ORDER BY id`,
      )
      .all() as RawKnowledge[];
    return rows.map(toRow);
  }

  /** Активные знания (не refuted) — для курации. */
  listActive(): KnowledgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, title, body, epistemic_status, provenance, created_at, updated_at
         FROM knowledge WHERE epistemic_status != 'refuted'
         ORDER BY id`,
      )
      .all() as RawKnowledge[];
    return rows.map(toRow);
  }

  /** L1: corroborated facts for Q-LLM consolidation batch (least-used first). */
  listForConsolidation(limit: number): KnowledgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, title, body, epistemic_status, provenance, created_at, updated_at
         FROM knowledge
         WHERE epistemic_status = 'corroborated' AND kind = 'fact'
         ORDER BY use_count ASC, updated_at ASC
         LIMIT ?`,
      )
      .all(limit) as RawKnowledge[];
    return rows.map(toRow);
  }

  truncateBody(body: string): string {
    if (body.length <= MAX_BODY_INJECT) return body;
    return `${body.slice(0, MAX_BODY_INJECT)}…`;
  }
}

interface RawKnowledge {
  id: number;
  kind: KnowledgeKind;
  title: string;
  body: string;
  epistemic_status: EpistemicStatus;
  provenance: MemoryProvenance;
  created_at: number;
  updated_at: number;
}

function toRow(r: RawKnowledge): KnowledgeRow {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    epistemicStatus: r.epistemic_status,
    provenance: r.provenance,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
