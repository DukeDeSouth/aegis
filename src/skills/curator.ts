/**
 * F6: детерминированный Skill Curator — отчёт + archive/unarchive (без LLM).
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySnapshot } from '../memory/snapshot.ts';
import { normalizeKey } from '../memory/curation.ts';
import type { SkillRegistry } from './registry.ts';
import type { SkillMetricsStore } from './metrics.ts';
import type { SkillManifest } from './types.ts';

const ARCHIVE_DIR = '.archive';

export interface SkillCuratorOptions {
  skillsDir: string;
  staleDays?: number;
  minSuccessRate?: number;
  minSamples?: number;
  now?: () => number;
}

export interface SkillCuratorReport {
  stale: string[];
  lowSuccess: { name: string; rate: number; invocations: number }[];
  duplicates: string[][];
}

export class SkillCurator {
  private readonly metrics: SkillMetricsStore;
  private readonly registry: SkillRegistry;
  private readonly snapshot: MemorySnapshot;
  private readonly skillsDir: string;
  private readonly staleMs: number;
  private readonly minSuccessRate: number;
  private readonly minSamples: number;
  private readonly now: () => number;

  constructor(
    metrics: SkillMetricsStore,
    registry: SkillRegistry,
    snapshot: MemorySnapshot,
    opts: SkillCuratorOptions,
  ) {
    this.metrics = metrics;
    this.registry = registry;
    this.snapshot = snapshot;
    this.skillsDir = opts.skillsDir;
    this.staleMs = (opts.staleDays ?? 30) * 24 * 60 * 60 * 1000;
    this.minSuccessRate = opts.minSuccessRate ?? 0.5;
    this.minSamples = opts.minSamples ?? 3;
    this.now = opts.now ?? Date.now;
  }

  analyze(): SkillCuratorReport {
    const now = this.now();
    const installed = new Set(this.registry.list().map((s) => s.name));
    const metricByName = new Map(this.metrics.list().map((m) => [m.skillName, m]));

    const stale: string[] = [];
    for (const name of installed) {
      const m = metricByName.get(name);
      if (!m || m.lastUsedAt === null || now - m.lastUsedAt > this.staleMs) {
        stale.push(name);
      }
    }

    const lowSuccess: SkillCuratorReport['lowSuccess'] = [];
    for (const name of installed) {
      const m = metricByName.get(name);
      if (!m || m.invocations < this.minSamples) continue;
      const rate = m.successes / m.invocations;
      if (rate < this.minSuccessRate) {
        lowSuccess.push({ name, rate, invocations: m.invocations });
      }
    }

    const byManifest = new Map<string, string[]>();
    const byBody = new Map<string, string[]>();
    for (const s of this.registry.list()) {
      const manifest = this.registry.getManifest(s.name);
      if (manifest) {
        const key = manifestKey(manifest);
        const list = byManifest.get(key) ?? [];
        list.push(s.name);
        byManifest.set(key, list);
      }
      const md = this.registry.view(s.name);
      if (md) {
        const bodyKey = normalizeKey(s.name, md);
        const list = byBody.get(bodyKey) ?? [];
        list.push(s.name);
        byBody.set(bodyKey, list);
      }
    }
    const duplicates: string[][] = [];
    for (const groups of [byManifest, byBody]) {
      for (const names of groups.values()) {
        if (names.length > 1) duplicates.push([...names].sort());
      }
    }

    return { stale, lowSuccess, duplicates: dedupeGroups(duplicates) };
  }

  formatReport(report: SkillCuratorReport): string {
    const lines = ['## Skill curation'];
    if (report.stale.length === 0) lines.push('Stale: none');
    else lines.push(`Stale (archive candidates): ${report.stale.join(', ')}`);
    if (report.lowSuccess.length === 0) {
      lines.push('Low success rate: none');
    } else {
      lines.push(
        'Low success rate:',
        ...report.lowSuccess.map(
          (r) =>
            `- ${r.name}: ${Math.round(r.rate * 100)}% (${r.invocations} invocations)`,
        ),
      );
    }
    if (report.duplicates.length === 0) {
      lines.push('Duplicates: none');
    } else {
      lines.push(
        'Duplicates:',
        ...report.duplicates.map((g) => `- ${g.join(' ≈ ')}`),
      );
    }
    lines.push('Apply: /skill-archive <name>, /skill-unarchive <name>');
    return lines.join('\n');
  }

  archive(skillName: string): number {
    const src = join(this.skillsDir, skillName);
    if (!existsSync(src)) throw new Error(`skill not found: ${skillName}`);
    const snap = this.snapshot.create(`pre-skill-archive:${skillName}`);
    const destRoot = join(this.skillsDir, ARCHIVE_DIR);
    const dest = join(destRoot, skillName);
    if (!existsSync(destRoot)) mkdirSync(destRoot, { recursive: true });
    if (existsSync(dest)) throw new Error(`already archived: ${skillName}`);
    renameSync(src, dest);
    this.registry.reload();
    return snap.id;
  }

  unarchive(skillName: string): void {
    const src = join(this.skillsDir, ARCHIVE_DIR, skillName);
    const dest = join(this.skillsDir, skillName);
    if (!existsSync(src)) throw new Error(`not in archive: ${skillName}`);
    if (existsSync(dest)) throw new Error(`skill already installed: ${skillName}`);
    renameSync(src, dest);
    this.registry.reload();
  }

  listArchived(): string[] {
    const root = join(this.skillsDir, ARCHIVE_DIR);
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory());
  }
}

function manifestKey(m: SkillManifest): string {
  return `${m.action_class}\0${[...m.needs].sort().join(',')}`;
}

function dedupeGroups(groups: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const g of groups) {
    const key = g.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}
