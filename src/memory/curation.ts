/**
 * Детерминированная курация памяти: staleness, dedup, decay (Sprint 6).
 */
import type Database from 'better-sqlite3';
import type { KnowledgeStore } from './knowledge.ts';
import { PromotionGate } from './promotion.ts';
import type { MemorySnapshot } from './snapshot.ts';

export interface CurationResult {
  snapshotId: number;
  staleRefuted: number;
  dedupRefuted: number;
  decayRefuted: number;
}

export interface CurationRunnerOptions {
  now?: () => number;
  decayDays?: number;
}

export class CurationRunner {
  private readonly db: Database.Database;
  private readonly knowledge: KnowledgeStore;
  private readonly promotion: PromotionGate;
  private readonly snapshot: MemorySnapshot;
  private readonly now: () => number;
  private readonly decayMs: number;

  constructor(
    db: Database.Database,
    knowledge: KnowledgeStore,
    promotion: PromotionGate,
    snapshot: MemorySnapshot,
    opts: CurationRunnerOptions = {},
  ) {
    this.db = db;
    this.knowledge = knowledge;
    this.promotion = promotion;
    this.snapshot = snapshot;
    const nowFn = opts.now ?? Date.now;
    this.now = nowFn;
    this.decayMs = (opts.decayDays ?? 90) * 24 * 60 * 60 * 1000;
  }

  run(): CurationResult {
    const snap = this.snapshot.create('pre-curation');
    const staleRefuted = this.refuteStale();
    const dedupRefuted = this.refuteDuplicates();
    const decayRefuted = this.refuteDecayed();
    return {
      snapshotId: snap.id,
      staleRefuted,
      dedupRefuted,
      decayRefuted,
    };
  }

  private refuteStale(): number {
    const ts = this.now();
    const rows = this.db
      .prepare(
        `SELECT id FROM knowledge
         WHERE stale_after IS NOT NULL AND stale_after < ?
           AND epistemic_status NOT IN ('refuted')`,
      )
      .all(ts) as { id: number }[];
    for (const row of rows) {
      this.promotion.refute(row.id, 'decay', 'stale_after exceeded');
    }
    return rows.length;
  }

  private refuteDuplicates(): number {
    const rows = this.knowledge.listActive();
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const key = normalizeKey(row.title, row.body);
      const ids = groups.get(key) ?? [];
      ids.push(row.id);
      groups.set(key, ids);
    }
    let count = 0;
    for (const ids of groups.values()) {
      if (ids.length <= 1) continue;
      const keep = Math.max(...ids);
      for (const id of ids) {
        if (id === keep) continue;
        this.promotion.refute(id, 'refutation', `duplicate of knowledge #${keep}`);
        count++;
      }
    }
    return count;
  }

  private refuteDecayed(): number {
    const cutoff = this.now() - this.decayMs;
    const rows = this.db
      .prepare(
        `SELECT id FROM knowledge
         WHERE use_count = 0 AND created_at < ?
           AND epistemic_status NOT IN ('refuted')`,
      )
      .all(cutoff) as { id: number }[];
    for (const row of rows) {
      this.promotion.refute(row.id, 'decay', 'unused knowledge decay');
    }
    return rows.length;
  }
}

export function normalizeKey(title: string, body: string): string {
  const t = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const b = body.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${t}\0${b}`;
}
