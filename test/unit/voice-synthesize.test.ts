/**
 * Unit Sprint 36 / U2: voice synthesizer + helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  SandboxVoiceSynthesizer,
  capTtsText,
  isSafeVoiceRelPath,
} from '../../src/host/adapter/voice.ts';
import type { SandboxRunner, SandboxRunResult } from '../../src/sandbox/types.ts';

function mockRunner(result: Partial<SandboxRunResult> = {}): SandboxRunner {
  return {
    run(): Promise<SandboxRunResult> {
      return Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...result,
      });
    },
  };
}

describe('voice TTS helpers (U2)', () => {
  it('capTtsText truncates long replies', () => {
    const long = 'a'.repeat(3000);
    expect(capTtsText(long).length).toBeLessThanOrEqual(2000);
  });

  it('isSafeVoiceRelPath rejects traversal', () => {
    expect(isSafeVoiceRelPath('outgoing/x.ogg')).toBe(true);
    expect(isSafeVoiceRelPath('../etc/passwd')).toBe(false);
    expect(isSafeVoiceRelPath('/abs')).toBe(false);
  });

  it('SandboxVoiceSynthesizer invokes voice-synthesize.sh with network none', async () => {
    let capturedEntry = '';
    let capturedHosts: string[] | undefined;
    const runner: SandboxRunner = {
      run(_skill, entry, limits) {
        capturedEntry = entry;
        capturedHosts = limits.allowedHosts;
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
      },
    };
    const synth = new SandboxVoiceSynthesizer({ runner, mediaImage: 'media:test' });
    await synth.synthesize('hello', 'outgoing/test.ogg');
    expect(capturedEntry).toBe('voice-synthesize.sh');
    expect(capturedHosts).toEqual([]);
  });

  it('SandboxVoiceSynthesizer throws on sandbox failure', async () => {
    const synth = new SandboxVoiceSynthesizer({
      runner: mockRunner({ exitCode: 1, stderr: 'TTS_ERROR' }),
    });
    await expect(synth.synthesize('x', 'outgoing/x.ogg')).rejects.toThrow('TTS_ERROR');
  });
});
