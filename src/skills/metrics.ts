/**
 * F6: счётчики invocations / success / last_used_at по навыкам.
 */
import type Database from 'better-sqlite3';

export interface SkillMetricRow {
  skillName: string;
  invocations: number;
  successes: number;
  lastUsedAt: number | null;
}

export interface SkillMetricsStoreOptions {
  now?: () => number;
}

export class SkillMetricsStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: SkillMetricsStoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  recordTurn(skillName: string, success: boolean): void {
    const ts = this.now();
    const ok = success ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO skill_metrics (skill_name, invocations, successes, last_used_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(skill_name) DO UPDATE SET
           invocations = invocations + 1,
           successes = successes + ?,
           last_used_at = excluded.last_used_at`,
      )
      .run(skillName, ok, ts, ok);
  }

  get(skillName: string): SkillMetricRow | undefined {
    const row = this.db
      .prepare(
        `SELECT skill_name, invocations, successes, last_used_at FROM skill_metrics WHERE skill_name = ?`,
      )
      .get(skillName) as
      | { skill_name: string; invocations: number; successes: number; last_used_at: number | null }
      | undefined;
    if (!row) return undefined;
    return {
      skillName: row.skill_name,
      invocations: row.invocations,
      successes: row.successes,
      lastUsedAt: row.last_used_at,
    };
  }

  list(): SkillMetricRow[] {
    return (
      this.db
        .prepare(
          `SELECT skill_name, invocations, successes, last_used_at FROM skill_metrics ORDER BY skill_name`,
        )
        .all() as {
        skill_name: string;
        invocations: number;
        successes: number;
        last_used_at: number | null;
      }[]
    ).map((r) => ({
      skillName: r.skill_name,
      invocations: r.invocations,
      successes: r.successes,
      lastUsedAt: r.last_used_at,
    }));
  }

  successRate(row: SkillMetricRow): number | null {
    if (row.invocations === 0) return null;
    return row.successes / row.invocations;
  }
}

export interface SkillReuseSnapshot {
  skillsTracked: number;
  skillsUsed: number;
  reuseRate: number | null;
}

export function computeSkillReuseMetrics(db: Database.Database): SkillReuseSnapshot {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS tracked,
         SUM(CASE WHEN invocations > 0 THEN 1 ELSE 0 END) AS used
       FROM skill_metrics`,
    )
    .get() as { tracked: number | null; used: number | null };
  const tracked = row.tracked ?? 0;
  const used = row.used ?? 0;
  return {
    skillsTracked: tracked,
    skillsUsed: used,
    reuseRate: tracked > 0 ? used / tracked : null,
  };
}
