import { describe, expect, it } from 'vitest';
import { openDb, applyMigration } from '../../src/memory/db.ts';
import { readFileSync } from 'node:fs';
import { computeReuseMetrics, formatMetricsReport } from '../../src/memory/metrics.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('computeReuseMetrics', () => {
  it('считает reuse_rate по corroborated/verified с use_count > 0', () => {
    const db = openDb(':memory:');
    applyMigration(db, migration('0001-memory.sql'), 1);
    const knowledge = new KnowledgeStore(db);
    const id1 = knowledge.insert({
      title: 'a',
      body: 'one',
      provenance: 'owner',
      epistemicStatus: 'corroborated',
    });
    knowledge.insert({
      title: 'b',
      body: 'two',
      provenance: 'owner',
      epistemicStatus: 'verified',
    });
    knowledge.bumpUsage(id1);

    const m = computeReuseMetrics(db);
    expect(m.injectable).toBe(2);
    expect(m.used).toBe(1);
    expect(m.reuseRate).toBe(0.5);
  });

  it('reuseRate null при пустой injectable памяти', () => {
    const db = openDb(':memory:');
    applyMigration(db, migration('0001-memory.sql'), 1);
    knowledge_unverified_only(db);
    const m = computeReuseMetrics(db);
    expect(m.injectable).toBe(0);
    expect(m.reuseRate).toBeNull();
  });

  it('formatMetricsReport показывает N/A и budget', () => {
    const m = { injectable: 0, used: 0, reuseRate: null };
    const text = formatMetricsReport(m, { used: 10, limit: 100, backgroundBlocked: false });
    expect(text).toContain('N/A');
    expect(text).toContain('10/100');
  });
});

function knowledge_unverified_only(db: ReturnType<typeof openDb>): void {
  const knowledge = new KnowledgeStore(db);
  knowledge.insert({ title: 'x', body: 'y', provenance: 'owner', epistemicStatus: 'unverified' });
}
