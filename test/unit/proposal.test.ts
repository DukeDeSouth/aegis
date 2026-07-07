import { describe, expect, it } from 'vitest';
import {
  capabilitiesFromSignature,
  episodeActionToken,
  sessionSignature,
  validateNeedsSubset,
} from '../../src/skills/proposal.ts';
import type { EpisodeRow } from '../../src/memory/episodes.ts';
import type { SkillManifest } from '../../src/skills/types.ts';

describe('skill proposal detector', () => {
  it('maps commands to capability tokens', () => {
    expect(episodeActionToken('/fetch https://x.com')).toBe('web.fetch');
    expect(episodeActionToken('/write notes.md | hi')).toBe('files.write');
  });

  it('builds session signature', () => {
    const rows: EpisodeRow[] = [
      {
        id: 1,
        sessionId: 's1',
        role: 'owner',
        content: '/fetch https://a.com',
        provenance: 'owner',
        createdAt: 1,
      },
      {
        id: 2,
        sessionId: 's1',
        role: 'owner',
        content: '/summarize news',
        provenance: 'owner',
        createdAt: 2,
      },
    ];
    expect(sessionSignature(rows)).toBe('web.fetch>memory.read');
  });

  it('capabilitiesFromSignature is subset-safe', () => {
    const caps = capabilitiesFromSignature('web.fetch>memory.read');
    const manifest: SkillManifest = {
      schema_version: 1,
      name: 'x',
      version: '0.1.0',
      needs: ['web.fetch', 'messages.send'],
      network: ['aegis-broker'],
      action_class: 'read-only',
      code: false,
      entrypoints: [],
    };
    expect(validateNeedsSubset(manifest, caps)).toBe(true);
    expect(
      validateNeedsSubset({ ...manifest, needs: ['email.read'] }, caps),
    ).toBe(false);
  });
});
