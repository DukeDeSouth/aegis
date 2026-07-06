/**
 * Метрики ценности обучения: reuse_rate (docs/TOKEN_ECONOMY.md, Sprint 10).
 */
import type Database from 'better-sqlite3';

export interface ReuseMetricsSnapshot {
  injectable: number;
  used: number;
  /** null — нет injectable знаний (N/A). */
  reuseRate: number | null;
}

export interface BudgetMetricsLine {
  used: number;
  limit: number;
  backgroundBlocked: boolean;
}

export function computeReuseMetrics(db: Database.Database): ReuseMetricsSnapshot {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN epistemic_status IN ('corroborated', 'verified') THEN 1 ELSE 0 END) AS injectable,
         SUM(CASE WHEN epistemic_status IN ('corroborated', 'verified') AND use_count > 0 THEN 1 ELSE 0 END) AS used
       FROM knowledge`,
    )
    .get() as { injectable: number | null; used: number | null };
  const injectable = row.injectable ?? 0;
  const used = row.used ?? 0;
  return {
    injectable,
    used,
    reuseRate: injectable > 0 ? used / injectable : null,
  };
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function formatMetricsReport(
  metrics: ReuseMetricsSnapshot,
  budget?: BudgetMetricsLine,
): string {
  const lines: string[] = ['## Aegis metrics'];
  if (metrics.injectable === 0) {
    lines.push('Reuse rate: N/A (no corroborated/verified knowledge yet)');
  } else {
    lines.push(
      `Reuse rate: ${formatPercent(metrics.reuseRate!)} (${metrics.used}/${metrics.injectable} knowledge rows used in prompts)`,
    );
  }
  if (budget) {
    lines.push(
      `Budget today: ${budget.used}/${budget.limit} tokens` +
        (budget.backgroundBlocked ? ' (background LLM blocked)' : ''),
    );
  }
  lines.push('Self-improvement LLM: disabled by default in MVP (see learning config).');
  return lines.join('\n');
}
