/**
 * Эпизодическая память: запись сессий + FTS5-поиск без LLM (docs/LEARNING_LOOP.md).
 */
import type Database from 'better-sqlite3';
import type { MemoryProvenance } from './types.ts';

export type EpisodeRole = 'owner' | 'assistant' | 'tool' | 'quarantine';

export interface EpisodeRow {
  id: number;
  sessionId: string;
  role: EpisodeRole;
  content: string;
  provenance: MemoryProvenance;
  createdAt: number;
}

export interface EpisodeHit extends EpisodeRow {
  rank: number;
}

export interface EpisodeStoreOptions {
  now?: () => number;
}

/** Экранирует пользовательский запрос для FTS5 MATCH (токены в кавычках). */
export function escapeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '""';
  return trimmed
    .split(/\s+/)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

export class EpisodeStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: EpisodeStoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  append(
    sessionId: string,
    role: EpisodeRole,
    content: string,
    provenance: MemoryProvenance,
  ): number {
    const ts = this.now();
    const res = this.db
      .prepare(
        `INSERT INTO episodes (session_id, role, content, provenance, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, role, content, provenance, ts);
    return Number(res.lastInsertRowid);
  }

  search(query: string, opts: { limit?: number; sessionId?: string } = {}): EpisodeHit[] {
    const limit = opts.limit ?? 5;
    const term = escapeFtsQuery(query);
    if (term === '""') return [];

    const rows = opts.sessionId
      ? (this.db
          .prepare(
            `SELECT e.id, e.session_id, e.role, e.content, e.provenance, e.created_at,
                    bm25(episodes_fts) AS rank
             FROM episodes_fts
             JOIN episodes e ON e.id = episodes_fts.rowid
             WHERE episodes_fts MATCH ? AND e.session_id = ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(term, opts.sessionId, limit) as RawEpisode[])
      : (this.db
          .prepare(
            `SELECT e.id, e.session_id, e.role, e.content, e.provenance, e.created_at,
                    bm25(episodes_fts) AS rank
             FROM episodes_fts
             JOIN episodes e ON e.id = episodes_fts.rowid
             WHERE episodes_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(term, limit) as RawEpisode[]);

    return rows.map(toHit);
  }

  listBySession(sessionId: string, limit = 50): EpisodeRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, role, content, provenance, created_at
         FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as RawEpisode[];
    return rows.map(toRow);
  }

  /** Последние N реплик сессии в хронологическом порядке (Sprint 11). */
  tailBySession(sessionId: string, limit: number): EpisodeRow[] {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, session_id, role, content, provenance, created_at
         FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as RawEpisode[];
    return rows.map(toRow).reverse();
  }
}

interface RawEpisode {
  id: number;
  session_id: string;
  role: EpisodeRole;
  content: string;
  provenance: MemoryProvenance;
  created_at: number;
  rank?: number;
}

function toRow(r: RawEpisode): EpisodeRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    provenance: r.provenance,
    createdAt: r.created_at,
  };
}

function toHit(r: RawEpisode): EpisodeHit {
  return { ...toRow(r), rank: r.rank ?? 0 };
}
