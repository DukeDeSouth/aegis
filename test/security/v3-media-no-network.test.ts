/**
 * V3 Sprint 33: media sandbox jobs use network none (allowedHosts empty).
 */
import { describe, expect, it } from 'vitest';
import { buildRunArgs } from '../../src/sandbox/runner.ts';

const IMAGE = 'aegis-media:test@sha256:deadbeef';
const NET = 'aegis-internal';

describe('media sandbox network isolation (V3)', () => {
  it('media transcode limits → --network none', () => {
    const argv = buildRunArgs({
      name: 'aegis-sb-media',
      skillDir: '/skills/media-pipeline',
      entrypoint: 'transcode.sh',
      limits: { timeoutMs: 300_000, memoryBytes: 512 * 1024 * 1024, allowedHosts: [] },
      image: IMAGE,
      internalNetwork: NET,
      workspaceDir: '/tmp/ws',
    });
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
    expect(argv.join(' ')).toContain('/tmp/ws:/workspace:rw');
  });

  it('voice synthesize limits → --network none', () => {
    const argv = buildRunArgs({
      name: 'aegis-sb-tts',
      skillDir: '/skills/media-pipeline',
      entrypoint: 'voice-synthesize.sh',
      limits: { timeoutMs: 60_000, memoryBytes: 512 * 1024 * 1024, allowedHosts: [] },
      image: IMAGE,
      internalNetwork: NET,
      workspaceDir: '/tmp/ws',
    });
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
  });
});
