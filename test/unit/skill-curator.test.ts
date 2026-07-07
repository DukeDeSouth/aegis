import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillCurator } from '../../src/skills/curator.ts';
import { SkillMetricsStore } from '../../src/skills/metrics.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('SkillCurator.analyze', () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags stale and low-success skills', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-cur-'));
    const skillsDir = join(root, 'skills');
    const staleDir = join(skillsDir, 'stale-skill');
    const badDir = join(skillsDir, 'bad-skill');
    for (const d of [staleDir, badDir]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, 'manifest.json'),
        JSON.stringify({
          schema_version: 1,
          name: d.split('/').pop(),
          version: '0.1.0',
          needs: [],
          network: 'none',
          action_class: 'read-only',
          code: false,
          entrypoints: [],
        }),
      );
      writeFileSync(
        join(d, 'SKILL.md'),
        `---\nname: ${d.split('/').pop()}\ndescription: test\n---\n# t`,
      );
    }
    const memPath = join(root, 'm.db');
    const db = openDb(memPath);
    applyMigration(db, migration('0001-memory.sql'), 1);
    applyMigration(db, migration('0007-memory.sql'), 7);
    const metrics = new SkillMetricsStore(db, { now: () => 1_000_000 });
    metrics.recordTurn('bad-skill', false);
    metrics.recordTurn('bad-skill', false);
    metrics.recordTurn('bad-skill', false);
    const registry = new SkillRegistry(skillsDir);
    const curator = new SkillCurator(metrics, registry, new MemorySnapshot(db, memPath, join(root, 's')), {
      skillsDir,
      staleDays: 1,
      minSuccessRate: 0.5,
      now: () => 1_000_000 + 2 * 24 * 60 * 60 * 1000,
    });
    const report = curator.analyze();
    expect(report.stale).toContain('stale-skill');
    expect(report.lowSuccess.some((r) => r.name === 'bad-skill')).toBe(true);
  });
});
