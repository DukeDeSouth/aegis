/**
 * Валидация навыков: JSON Schema (zod) + семантические правила ADR-0007.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ActionClass } from '../host/gate/types.ts';
import {
  CAPABILITY_REGISTRY,
  NETWORK_REQUIRED_CAPABILITIES,
  type SkillManifest,
  type ValidationResult,
} from './types.ts';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

const capabilitySchema = z.enum(CAPABILITY_REGISTRY);

const manifestSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().regex(NAME_RE).max(64),
    version: z.string().regex(SEMVER_RE),
    needs: z.array(capabilitySchema),
    network: z.union([z.literal('none'), z.array(z.string().min(1))]),
    action_class: z.enum(['read-only', 'reversible', 'irreversible']),
    code: z.boolean(),
    entrypoints: z.array(z.string().min(1)),
    requires_review: z.boolean().optional(),
  })
  .strict();

export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!match) return {};
  const yaml = match[1]!;
  const name = /^name:\s*(.+)$/m.exec(yaml)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(yaml)?.[1]?.trim();
  const out: { name?: string; description?: string } = {};
  if (name !== undefined) out.name = name;
  if (description !== undefined) out.description = description;
  return out;
}

function fail(errors: string[]): ValidationResult {
  return { ok: false, errors };
}

function ok(): ValidationResult {
  return { ok: true, errors: [] };
}

/** Семантические правила поверх структурной схемы. */
export function validateManifestSemantics(
  manifest: SkillManifest,
  skillDir: string,
  dirName: string,
  frontmatterName?: string,
): ValidationResult {
  const errors: string[] = [];

  if (manifest.name !== dirName) {
    errors.push(`manifest.name "${manifest.name}" != directory "${dirName}"`);
  }
  if (frontmatterName !== undefined && frontmatterName !== manifest.name) {
    errors.push(`SKILL.md frontmatter name "${frontmatterName}" != manifest.name`);
  }

  const scriptsDir = join(skillDir, 'scripts');
  const hasScripts = existsSync(scriptsDir) && readdirSync(scriptsDir).length > 0;

  if (!manifest.code) {
    if (manifest.entrypoints.length > 0) {
      errors.push('code:false requires entrypoints=[]');
    }
    if (hasScripts) {
      errors.push('code:false forbids scripts/ directory');
    }
  } else {
    if (manifest.entrypoints.length === 0) {
      errors.push('code:true requires at least one entrypoint');
    }
    for (const ep of manifest.entrypoints) {
      const p = join(skillDir, ep);
      if (!existsSync(p)) {
        errors.push(`entrypoint not found: ${ep}`);
      }
      if (ep.includes('..') || ep.startsWith('/')) {
        errors.push(`entrypoint must be relative inside skill: ${ep}`);
      }
    }
  }

  if (manifest.network === 'none') {
    for (const cap of manifest.needs) {
      if (NETWORK_REQUIRED_CAPABILITIES.has(cap)) {
        errors.push(`network:none incompatible with capability ${cap}`);
      }
    }
  }

  return errors.length > 0 ? fail(errors) : ok();
}

export function validateManifestFile(
  raw: unknown,
  skillDir: string,
  dirName: string,
  skillMd?: string,
): ValidationResult {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const fm = skillMd ? parseSkillFrontmatter(skillMd) : {};
  return validateManifestSemantics(parsed.data, skillDir, dirName, fm.name);
}

export function parseManifest(raw: unknown): SkillManifest {
  return manifestSchema.parse(raw);
}

export function actionClassFromManifest(manifest: SkillManifest): ActionClass {
  return manifest.action_class;
}
