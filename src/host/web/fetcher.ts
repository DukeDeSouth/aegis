/**
 * web.fetch: загрузка через sandbox + broker (F2). Ядро не держит HTTP-клиент.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxRunner } from '../../sandbox/types.ts';
import { validateFetchUrl } from './url.ts';

const DEFAULT_SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../skills/web-fetch');

export interface WebFetchConfig {
  brokerHost: string;
  maxResponseBytes: number;
  skillDir?: string;
}

export interface WebFetcher {
  fetch(url: string): Promise<string>;
}

export class SandboxWebFetcher implements WebFetcher {
  private readonly runner: SandboxRunner;
  private readonly brokerHost: string;
  private readonly maxBytes: number;
  private readonly skillDir: string;

  constructor(runner: SandboxRunner, config: WebFetchConfig) {
    this.runner = runner;
    this.brokerHost = config.brokerHost;
    this.maxBytes = config.maxResponseBytes;
    this.skillDir = config.skillDir ?? DEFAULT_SKILL_DIR;
  }

  async fetch(url: string): Promise<string> {
    const v = validateFetchUrl(url);
    if (!v.ok) throw new Error(v.reason);
    const path = `${v.url.pathname}${v.url.search}` || '/';
    const result = await this.runner.run(
      this.skillDir,
      'fetch.sh',
      {
        timeoutMs: 30_000,
        memoryBytes: 64 * 1024 * 1024,
        allowedHosts: [this.brokerHost.split(':')[0] ?? this.brokerHost],
      },
      {
        TARGET_HOST: v.url.hostname,
        TARGET_PATH: path,
        BROKER_HOST: this.brokerHost,
        MAX_BYTES: String(this.maxBytes),
      },
    );
    if (result.timedOut) throw new Error('web fetch timed out');
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `fetch exit ${result.exitCode}`);
    }
    return result.stdout.trim();
  }
}

/** Тестовый/интеграционный fetcher без Docker. */
export class StaticWebFetcher implements WebFetcher {
  constructor(private readonly pages: Record<string, string>) {}

  async fetch(url: string): Promise<string> {
    const v = validateFetchUrl(url);
    if (!v.ok) throw new Error(v.reason);
    const body = this.pages[url] ?? this.pages[v.url.href];
    if (body === undefined) throw new Error('page not found in static fetcher');
    return body;
  }
}
