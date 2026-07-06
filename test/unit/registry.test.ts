import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../src/skills/registry.ts';

let tmp = '';

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

function writeSkill(name: string, code = false): void {
  tmp = mkdtempSync(join(tmpdir(), 'aegis-skill-reg-'));
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '0.1.0',
      needs: [],
      network: 'none',
      action_class: 'read-only',
      code,
      entrypoints: code ? ['scripts/run.sh'] : [],
    }),
  );
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---
name: ${name}
description: Test skill ${name}
---
# ${name}
`,
  );
  if (code) {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n');
  }
}

describe('SkillRegistry', () => {
  it('загружает echo-procedure из репозитория', () => {
    const reg = new SkillRegistry(join(process.cwd(), 'skills'));
    expect(reg.has('echo-procedure')).toBe(true);
    expect(reg.listForPrompt().some((s) => s.name === 'echo-procedure')).toBe(true);
  });

  it('code-навык не в prompt до corroborate', () => {
    writeSkill('code-skill', true);
    const reg = new SkillRegistry(tmp);
    expect(reg.list()).toHaveLength(1);
    expect(reg.listForPrompt()).toHaveLength(0);
    reg.markCorroborated('code-skill');
    expect(reg.listForPrompt()).toHaveLength(1);
  });

  it('buildPromptSection — прогрессивное раскрытие', () => {
    writeSkill('alpha');
    const reg = new SkillRegistry(tmp);
    const section = reg.buildPromptSection();
    expect(section).toContain('## Available skills');
    expect(section).toContain('- alpha:');
    expect(section).not.toContain('# alpha');
  });
});
