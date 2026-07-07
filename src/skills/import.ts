/**
 * F7: импорт внешних SKILL.md (agentskills.io) → manifest ADR-0007.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFrontmatter } from './validate.ts';
import type { ActionClass } from '../host/gate/types.ts';
import type { CapabilityId, SkillManifest } from './types.ts';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CAP_RULES: { cap: CapabilityId; re: RegExp }[] = [
  { cap: 'web.fetch', re: /\b(fetch|https?:\/\/|curl\b|wget\b|browse\s+url|web\s+page)\b/i },
  { cap: 'files.read', re: /\b(read\s+file|open\s+file|\/read\b|cat\s+file)\b/i },
  { cap: 'files.write', re: /\b(write\s+file|save\s+to|\/write\b|create\s+file)\b/i },
  { cap: 'messages.send', re: /\b(send\s+message|telegram|notify|email\s+user|\/message)\b/i },
  { cap: 'memory.read', re: /\b(search\s+memory|\/search\b|\/summarize\b|recall)\b/i },
  { cap: 'schedule.manage', re: /\b(\/remind\b|schedule|cron\b|reminder)\b/i },
  { cap: 'email.read', re: /\b(read\s+email|inbox)\b/i },
  { cap: 'email.draft', re: /\b(draft\s+email|compose\s+email)\b/i },
];

const REVIEW_PATTERNS = [
  /\bcurl\s+[^\n|]*\|/i,
  /\b(wget|curl)\b.*\b(secret|token|key|password|credential)\b/i,
  /\bchild_process\b/,
  /\beval\s*\(/,
  /\ballowed-tools\b/i,
  /\bshell\b|\bbash\b|\bexec\b/i,
];

export interface ExternalImportResult {
  manifest: SkillManifest;
  requiresReview: boolean;
  warnings: string[];
}

export function slugSkillName(raw: string, fallbackDir: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const name = base.length > 0 ? base : fallbackDir;
  return NAME_RE.test(name) ? name : fallbackDir.replace(/[^a-z0-9-]/g, '-').slice(0, 64);
}

export function inferCapabilities(text: string): CapabilityId[] {
  const caps = new Set<CapabilityId>();
  for (const { cap, re } of CAP_RULES) {
    if (re.test(text)) caps.add(cap);
  }
  return [...caps];
}

function detectCode(skillDir: string): { code: boolean; entrypoints: string[] } {
  const scriptsDir = join(skillDir, 'scripts');
  if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
    const eps = readdirSync(scriptsDir).filter((f) => /\.(sh|bash|py|js)$/i.test(f));
    if (eps.length > 0) return { code: true, entrypoints: eps.map((f) => `scripts/${f}`) };
  }
  const root = readdirSync(skillDir).filter((f) => /\.(sh|bash)$/i.test(f));
  if (root.length > 0) return { code: true, entrypoints: root };
  return { code: false, entrypoints: [] };
}

function networkFor(needs: CapabilityId[]): SkillManifest['network'] {
  if (needs.includes('web.fetch')) return ['aegis-broker'];
  if (needs.some((n) => n === 'messages.send' || n.startsWith('email.'))) return ['outbound'];
  return 'none';
}

function actionClassFor(needs: CapabilityId[]): ActionClass {
  if (needs.includes('files.write') || needs.includes('schedule.manage')) return 'reversible';
  return 'read-only';
}

export function importExternalSkill(skillDir: string, skillMd?: string): ExternalImportResult {
  const md = skillMd ?? readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const fm = parseSkillFrontmatter(md);
  const dirName = skillDir.split('/').pop() ?? 'skill';
  const name = slugSkillName(fm.name ?? dirName, slugSkillName(dirName, 'imported-skill'));
  const body = md;
  const needs = inferCapabilities(body);
  const { code, entrypoints } = detectCode(skillDir);
  const warnings: string[] = [];

  let requiresReview = needs.length === 0;
  if (code && entrypoints.length === 0) {
    requiresReview = true;
    warnings.push('code artifacts detected but no entrypoints');
  }
  for (const re of REVIEW_PATTERNS) {
    if (re.test(body)) {
      requiresReview = true;
      warnings.push(`review pattern: ${re.source}`);
    }
  }
  if (!fm.description) {
    requiresReview = true;
    warnings.push('missing description in frontmatter');
  }

  const manifest: SkillManifest = {
    schema_version: 1,
    name,
    version: '0.1.0',
    needs,
    network: networkFor(needs),
    action_class: actionClassFor(needs),
    code,
    entrypoints,
    ...(requiresReview ? { requires_review: true } : {}),
  };

  return { manifest, requiresReview, warnings };
}

export function findImportableSkillRoot(cloneDir: string): string {
  if (existsSync(join(cloneDir, 'SKILL.md'))) return cloneDir;
  for (const c of readdirSync(cloneDir)) {
    const p = join(cloneDir, c);
    if (statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'))) return p;
  }
  throw new Error('no SKILL.md in clone');
}
