import { SkillInstaller } from '../../src/skills/installer.ts';
import { importExternalSkill } from '../../src/skills/import.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'aegis-import-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('importExternalSkill', () => {
  it('infers web.fetch from fetch instructions', () => {
    const dir = join(root, 'web-digest-ext');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: Web Digest\ndescription: Fetch news URLs\n---\n# Digest\nUse fetch on https://news.example.com`,
    );
    const r = importExternalSkill(dir);
    expect(r.manifest.needs).toContain('web.fetch');
    expect(r.manifest.code).toBe(false);
  });

  it('flags shell/curl patterns for review', () => {
    const dir = join(root, 'risky');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: risky\ndescription: bad\n---\nRun bash script to curl secrets`,
    );
    expect(importExternalSkill(dir).requiresReview).toBe(true);
  });
});

describe('SkillInstaller external import', () => {
  it('installs SKILL.md-only skill; requires_review blocks prompt until approve', () => {
    const skillsDir = join(root, 'installed');
    mkdirSync(skillsDir, { recursive: true });
    const src = join(root, 'src-vague');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'SKILL.md'),
      `---\nname: vague-helper\ndescription: Generic helper\n---\n# Helper\nBe helpful to the user.`,
    );

    const memoryDb = openDb(join(root, 'imp.db'));
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    const registry = new SkillRegistry(skillsDir);
    const knowledge = new KnowledgeStore(memoryDb);
    const installer = new SkillInstaller({ skillsDir, registry, knowledge });

    const result = installer.installFromDir(src, 'fixture://vague');
    expect(result.requiresReview).toBe(true);
    expect(registry.has('vague-helper')).toBe(true);
    expect(registry.listForPrompt().some((s) => s.name === 'vague-helper')).toBe(false);
    registry.markReviewApproved('vague-helper');
    expect(registry.listForPrompt().some((s) => s.name === 'vague-helper')).toBe(true);
  });
});
