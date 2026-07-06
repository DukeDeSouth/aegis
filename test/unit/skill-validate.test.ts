import { describe, expect, it } from 'vitest';
import { validateManifestFile, parseSkillFrontmatter } from '../../src/skills/validate.ts';

const VALID_MANIFEST = {
  schema_version: 1,
  name: 'echo-procedure',
  version: '0.1.0',
  needs: [] as const,
  network: 'none' as const,
  action_class: 'read-only' as const,
  code: false,
  entrypoints: [] as string[],
};

const SKILL_MD = `---
name: echo-procedure
description: Echo back
---

# Echo
`;

describe('skill validate (ADR-0007)', () => {
  it('принимает валидный декларативный манифест', () => {
    const r = validateManifestFile(
      VALID_MANIFEST,
      '/skills/echo-procedure',
      'echo-procedure',
      SKILL_MD,
    );
    expect(r.ok).toBe(true);
  });

  it('отклоняет неизвестную schema_version', () => {
    const r = validateManifestFile(
      { ...VALID_MANIFEST, schema_version: 2 },
      '/x',
      'echo-procedure',
      SKILL_MD,
    );
    expect(r.ok).toBe(false);
  });

  it('отклоняет неизвестную capability', () => {
    const r = validateManifestFile(
      { ...VALID_MANIFEST, needs: ['evil.hack'] },
      '/x',
      'echo-procedure',
      SKILL_MD,
    );
    expect(r.ok).toBe(false);
  });

  it('code:false запрещает entrypoints', () => {
    const r = validateManifestFile(
      { ...VALID_MANIFEST, entrypoints: ['scripts/run.sh'] },
      '/x',
      'echo-procedure',
      SKILL_MD,
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('entrypoints'))).toBe(true);
  });

  it('network:none несовместим с web.fetch', () => {
    const r = validateManifestFile(
      { ...VALID_MANIFEST, needs: ['web.fetch'] },
      '/x',
      'echo-procedure',
      SKILL_MD,
    );
    expect(r.ok).toBe(false);
  });

  it('расхождение frontmatter name → отказ', () => {
    const r = validateManifestFile(
      VALID_MANIFEST,
      '/x',
      'echo-procedure',
      `---
name: other
description: x
---
`,
    );
    expect(r.ok).toBe(false);
  });

  it('parseSkillFrontmatter извлекает name и description', () => {
    const fm = parseSkillFrontmatter(SKILL_MD);
    expect(fm.name).toBe('echo-procedure');
    expect(fm.description).toBe('Echo back');
  });
});
