/**
 * Реестр навыков: загрузка SKILL.md + manifest.json из skills_dir.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionClass } from '../host/gate/types.ts';
import { parseSkillFrontmatter, validateManifestFile } from './validate.ts';
import type { SkillManifest, SkillSummary } from './types.ts';

interface LoadedSkill {
  manifest: SkillManifest;
  description: string;
  skillMd: string;
  dir: string;
}

export class SkillRegistry {
  private readonly skillsDir: string;
  private readonly skills = new Map<string, LoadedSkill>();
  /** Имена code-навыков, прошедших dry-run (corroborated). */
  private readonly corroboratedCode = new Set<string>();
  /** F7: owner одобрил requires_review импорт. */
  private readonly reviewApproved = new Set<string>();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.reload();
  }

  reload(): void {
    this.skills.clear();
    if (!existsSync(this.skillsDir)) return;

    for (const entry of readdirSync(this.skillsDir)) {
      if (entry.startsWith('.')) continue;
      const dir = join(this.skillsDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, 'manifest.json');
      const skillPath = join(dir, 'SKILL.md');
      if (!existsSync(manifestPath) || !existsSync(skillPath)) continue;

      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      const skillMd = readFileSync(skillPath, 'utf8');
      const validation = validateManifestFile(raw, dir, entry, skillMd);
      if (!validation.ok) continue;

      const manifest = raw as SkillManifest;
      const fm = parseSkillFrontmatter(skillMd);
      this.skills.set(manifest.name, {
        manifest,
        description: fm.description ?? manifest.name,
        skillMd,
        dir,
      });
    }
  }

  list(): SkillSummary[] {
    return [...this.skills.values()].map((s) => ({
      name: s.manifest.name,
      description: s.description,
      code: s.manifest.code,
      actionClass: s.manifest.action_class,
    }));
  }

  /** Навыки для inject в system prompt (прогрессивное раскрытие: только метаданные). */
  listForPrompt(): SkillSummary[] {
    return this.list().filter((s) => {
      const m = this.skills.get(s.name)?.manifest;
      if (m?.requires_review && !this.reviewApproved.has(s.name)) return false;
      return !s.code || this.corroboratedCode.has(s.name);
    });
  }

  view(name: string): string | undefined {
    return this.skills.get(name)?.skillMd;
  }

  getManifest(name: string): SkillManifest | undefined {
    return this.skills.get(name)?.manifest;
  }

  getSkillDir(name: string): string | undefined {
    return this.skills.get(name)?.dir;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  markCorroborated(name: string): void {
    this.corroboratedCode.add(name);
  }

  isCodeSkillReady(name: string): boolean {
    const s = this.skills.get(name);
    if (!s) return false;
    if (s.manifest.requires_review && !this.reviewApproved.has(name)) return false;
    if (!s.manifest.code) return true;
    return this.corroboratedCode.has(name);
  }

  markReviewApproved(name: string): void {
    this.reviewApproved.add(name);
  }

  isReviewApproved(name: string): boolean {
    return this.reviewApproved.has(name);
  }

  /** max(action_class) среди навыков, доступных в prompt. */
  maxActionClassForPrompt(): ActionClass | undefined {
    const order: ActionClass[] = ['read-only', 'reversible', 'irreversible'];
    let maxIdx = -1;
    for (const s of this.listForPrompt()) {
      const idx = order.indexOf(s.actionClass);
      if (idx > maxIdx) maxIdx = idx;
    }
    return maxIdx >= 0 ? order[maxIdx] : undefined;
  }

  buildPromptSection(): string {
    const items = this.listForPrompt();
    if (items.length === 0) return '';
    const lines = items.map((s) => `- ${s.name}: ${s.description}`);
    return `## Available skills\n${lines.join('\n')}`;
  }

  registerLoaded(name: string, dir: string, manifest: SkillManifest, skillMd: string): void {
    const fm = parseSkillFrontmatter(skillMd);
    this.skills.set(name, {
      manifest,
      description: fm.description ?? manifest.name,
      skillMd,
      dir,
    });
  }
}
