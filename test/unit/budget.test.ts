import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/memory/db.ts';
import { applyMigration } from '../../src/memory/db.ts';
import { readFileSync } from 'node:fs';
import { BudgetEngine } from '../../src/host/budget/engine.ts';

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function makeBudget(limit: number, reserve: number): BudgetEngine {
  const db = openDb(':memory:');
  applyMigration(db, migration('0001-queue.sql'), 1);
  applyMigration(db, migration('0004-budget.sql'), 4);
  return new BudgetEngine(db, {
    dailyTokenLimit: limit,
    reserveForOwner: reserve,
    now: () => NOW,
  });
}

describe('BudgetEngine', () => {
  it('owner может тратить до полного лимита', () => {
    const b = makeBudget(1000, 200);
    expect(b.canSpend('owner', 500).allowed).toBe(true);
    b.recordUsage({ promptTokens: 900, completionTokens: 50, estimated: false });
    expect(b.canSpend('owner', 50).allowed).toBe(true);
    expect(b.canSpend('owner', 51).allowed).toBe(false);
  });

  it('scheduler уважает reserve_for_owner', () => {
    const b = makeBudget(1000, 200);
    b.recordUsage({ promptTokens: 850, completionTokens: 0, estimated: false });
    expect(b.canSpend('scheduler', 100).allowed).toBe(false);
    expect(b.canSpend('owner', 100).allowed).toBe(true);
    expect(b.status().backgroundBlocked).toBe(true);
  });

  it('recordUsage выставляет exhausted_at', () => {
    const b = makeBudget(100, 0);
    b.recordUsage({ promptTokens: 100, completionTokens: 0, estimated: false });
    expect(b.status().exhaustedAt).toBe(NOW);
  });
});
