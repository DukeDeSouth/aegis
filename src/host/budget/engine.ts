/**
 * Budget engine (docs/TOKEN_ECONOMY.md): дневной лимит токенов, приоритет owner над scheduler.
 */
import type Database from 'better-sqlite3';
import type { LlmUsage } from '../../llm/types.ts';
import type { QueueProvenance } from '../queue/store.ts';

export interface BudgetEngineOptions {
  dailyTokenLimit: number;
  reserveForOwner: number;
  now?: () => number;
}

export interface BudgetStatus {
  day: string;
  used: number;
  limit: number;
  reserveForOwner: number;
  exhaustedAt: number | undefined;
  /** Фон (scheduler) не может тратить LLM при исчерпании доступного пула. */
  backgroundBlocked: boolean;
}

export interface CanSpendResult {
  allowed: boolean;
  reason?: string;
}

function utcDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function totalTokens(usage: LlmUsage): number {
  return usage.promptTokens + usage.completionTokens;
}

export class BudgetEngine {
  private readonly db: Database.Database;
  private readonly dailyTokenLimit: number;
  private readonly reserveForOwner: number;
  private readonly now: () => number;

  constructor(db: Database.Database, opts: BudgetEngineOptions) {
    this.db = db;
    this.dailyTokenLimit = opts.dailyTokenLimit;
    this.reserveForOwner = opts.reserveForOwner;
    this.now = opts.now ?? Date.now;
  }

  private ensureDayRow(day: string): void {
    this.db
      .prepare(
        `INSERT INTO budget_daily (day, tokens_used, limit_tokens, exhausted_at)
         VALUES (?, 0, ?, NULL)
         ON CONFLICT(day) DO NOTHING`,
      )
      .run(day, this.dailyTokenLimit);
  }

  status(): BudgetStatus {
    const day = utcDay(this.now());
    this.ensureDayRow(day);
    const row = this.db
      .prepare(`SELECT tokens_used, limit_tokens, exhausted_at FROM budget_daily WHERE day = ?`)
      .get(day) as { tokens_used: number; limit_tokens: number; exhausted_at: number | null };
    const used = row.tokens_used;
    const limit = row.limit_tokens;
    const schedulerCap = Math.max(0, limit - this.reserveForOwner);
    return {
      day,
      used,
      limit,
      reserveForOwner: this.reserveForOwner,
      exhaustedAt: row.exhausted_at ?? undefined,
      backgroundBlocked: used >= schedulerCap,
    };
  }

  canSpend(provenance: QueueProvenance, estimateTokens: number): CanSpendResult {
    const st = this.status();
    const next = st.used + estimateTokens;

    if (provenance === 'owner') {
      if (next > st.limit) {
        return { allowed: false, reason: 'daily LLM budget exhausted' };
      }
      return { allowed: true };
    }

    if (provenance === 'scheduler') {
      const schedulerCap = Math.max(0, st.limit - st.reserveForOwner);
      if (next > schedulerCap) {
        return { allowed: false, reason: 'daily LLM budget exhausted for background tasks' };
      }
      return { allowed: true };
    }

    // Остальные провенансы — LLM только через owner/scheduler в MVP.
    return { allowed: false, reason: 'provenance not budgeted for LLM' };
  }

  recordUsage(usage: LlmUsage): void {
    const day = utcDay(this.now());
    this.ensureDayRow(day);
    const delta = totalTokens(usage);
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE budget_daily
         SET tokens_used = tokens_used + ?,
             exhausted_at = CASE
               WHEN tokens_used + ? >= limit_tokens AND exhausted_at IS NULL THEN ?
               ELSE exhausted_at
             END
         WHERE day = ?`,
      )
      .run(delta, delta, ts, day);
  }
}
