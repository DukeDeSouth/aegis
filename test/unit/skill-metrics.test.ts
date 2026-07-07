import { describe, expect, it } from 'vitest';
import { SkillMetricsStore } from '../../src/skills/metrics.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { readFileSync } from 'node:fs';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('SkillMetricsStore', () => {
  it('tracks invocations and success rate', () => {
    const db = openDb(':memory:');
    applyMigration(db, migration('0001-memory.sql'), 1);
    applyMigration(db, migration('0007-memory.sql'), 7);
    const m = new SkillMetricsStore(db);
    m.recordTurn('echo-procedure', true);
    m.recordTurn('echo-procedure', true);
    m.recordTurn('echo-procedure', false);
    const row = m.get('echo-procedure')!;
    expect(row.invocations).toBe(3);
    expect(row.successes).toBe(2);
    expect(m.successRate(row)).toBeCloseTo(2 / 3);
  });
});
