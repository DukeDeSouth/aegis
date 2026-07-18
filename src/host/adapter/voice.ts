/**
 * U1 (Sprint 33): voice STT via media sandbox skill — network none.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxRunner } from '../../sandbox/types.ts';

const DEFAULT_SKILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../skills/media-pipeline',
);

export const MAX_VOICE_DURATION_SEC = 300;
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;
export const MAX_TTS_CHARS = 2000;

export function capTtsText(text: string, max = MAX_TTS_CHARS): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const punct = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
  if (punct > slice.length * 0.5) return slice.slice(0, punct + 1);
  return `${slice.trimEnd()}…`;
}

export function isSafeVoiceRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('..')) return false;
  return true;
}

export interface VoiceTranscriber {
  transcribe(workspaceRelativePath: string, mockTranscript?: string): Promise<string>;
}

export interface SandboxVoiceTranscriberOptions {
  runner: SandboxRunner;
  workspaceDir: string;
  skillDir?: string;
  mediaImage?: string;
  timeoutMs?: number;
  memoryBytes?: number;
}

export class SandboxVoiceTranscriber implements VoiceTranscriber {
  private readonly runner: SandboxRunner;
  private readonly workspaceDir: string;
  private readonly skillDir: string;
  private readonly mediaImage: string | undefined;
  private readonly timeoutMs: number;
  private readonly memoryBytes: number;

  constructor(opts: SandboxVoiceTranscriberOptions) {
    this.runner = opts.runner;
    this.workspaceDir = opts.workspaceDir;
    this.skillDir = opts.skillDir ?? DEFAULT_SKILL_DIR;
    this.mediaImage = opts.mediaImage;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.memoryBytes = opts.memoryBytes ?? 512 * 1024 * 1024;
  }

  async transcribe(workspaceRelativePath: string, mockTranscript?: string): Promise<string> {
    const env: Record<string, string> = {
      INPUT_PATH: workspaceRelativePath,
      MEDIA_MOCK: process.env.MEDIA_MOCK ?? '',
    };
    if (mockTranscript !== undefined) env.MOCK_TRANSCRIPT = mockTranscript;
    const result = await this.runner.run(
      this.skillDir,
      'voice-transcribe.sh',
      {
        timeoutMs: this.timeoutMs,
        memoryBytes: this.memoryBytes,
        allowedHosts: [],
      },
      env,
      this.mediaImage !== undefined ? { image: this.mediaImage } : undefined,
    );
    if (result.timedOut) throw new Error('voice STT timed out');
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `voice STT exit ${result.exitCode}`);
    }
    const text = result.stdout.trim();
    if (!text) throw new Error('empty STT transcript');
    return text;
  }
}

/** Test double — returns fixed transcript without sandbox. */
export class StaticVoiceTranscriber implements VoiceTranscriber {
  constructor(private readonly transcript: string) {}

  transcribe(): Promise<string> {
    return Promise.resolve(this.transcript);
  }
}

export interface VoiceSynthesizer {
  synthesize(text: string, workspaceRelativePath: string): Promise<void>;
}

export interface SandboxVoiceSynthesizerOptions {
  runner: SandboxRunner;
  skillDir?: string;
  mediaImage?: string;
  timeoutMs?: number;
  memoryBytes?: number;
}

export class SandboxVoiceSynthesizer implements VoiceSynthesizer {
  private readonly runner: SandboxRunner;
  private readonly skillDir: string;
  private readonly mediaImage: string | undefined;
  private readonly timeoutMs: number;
  private readonly memoryBytes: number;

  constructor(opts: SandboxVoiceSynthesizerOptions) {
    this.runner = opts.runner;
    this.skillDir = opts.skillDir ?? DEFAULT_SKILL_DIR;
    this.mediaImage = opts.mediaImage;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.memoryBytes = opts.memoryBytes ?? 512 * 1024 * 1024;
  }

  async synthesize(text: string, workspaceRelativePath: string): Promise<void> {
    if (!isSafeVoiceRelPath(workspaceRelativePath)) {
      throw new Error('invalid voice output path');
    }
    const result = await this.runner.run(
      this.skillDir,
      'voice-synthesize.sh',
      {
        timeoutMs: this.timeoutMs,
        memoryBytes: this.memoryBytes,
        allowedHosts: [],
      },
      {
        TEXT: text,
        OUTPUT_REL: workspaceRelativePath,
        MEDIA_MOCK: process.env.MEDIA_MOCK ?? '',
      },
      this.mediaImage !== undefined ? { image: this.mediaImage } : undefined,
    );
    if (result.timedOut) throw new Error('voice TTS timed out');
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `voice TTS exit ${result.exitCode}`);
    }
  }
}

/** Test double — no-op synthesizer. */
export class StaticVoiceSynthesizer implements VoiceSynthesizer {
  synthesize(): Promise<void> {
    return Promise.resolve();
  }
}
