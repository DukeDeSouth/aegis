/**
 * web.fetch: загрузка через sandbox + broker (F2). Ядро не держит HTTP-клиент.
 */
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SandboxRunner } from '../../sandbox/types.ts';
import { validateFetchUrl } from './url.ts';

const DEFAULT_SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../skills/web-fetch');
const DEFAULT_FINANCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../connectors/finance');

export interface WebFetcher {
  fetch(url: string): Promise<string>;
  watch?(url: string): Promise<string>;
  financeIngest?(bodies: string): Promise<string>;
  financeReport?(month?: string): Promise<string>;
}

export interface WebFetchConfig {
  brokerHost: string;
  maxResponseBytes: number;
  skillDir?: string;
  financeDir?: string;
  workspaceDir?: string;
}

export class SandboxWebFetcher implements WebFetcher {
  private readonly runner: SandboxRunner;
  private readonly brokerHost: string;
  private readonly maxBytes: number;
  private readonly skillDir: string;
  private readonly financeDir: string;
  private readonly workspaceDir: string | undefined;

  constructor(runner: SandboxRunner, config: WebFetchConfig) {
    this.runner = runner;
    this.brokerHost = config.brokerHost;
    this.maxBytes = config.maxResponseBytes;
    this.skillDir = config.skillDir ?? DEFAULT_SKILL_DIR;
    this.financeDir = config.financeDir ?? DEFAULT_FINANCE_DIR;
    this.workspaceDir = config.workspaceDir;
  }

  private runScript(
    script: string,
    url: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const v = validateFetchUrl(url);
    if (!v.ok) throw new Error(v.reason);
    const path = `${v.url.pathname}${v.url.search}` || '/';
    return this.runner
      .run(
        this.skillDir,
        script,
        {
          timeoutMs: 30_000,
          memoryBytes: 64 * 1024 * 1024,
          allowedHosts: [this.brokerHost.split(':')[0] ?? this.brokerHost],
          ...(this.workspaceDir !== undefined ? { workspaceDir: this.workspaceDir } : {}),
        },
        {
          TARGET_HOST: v.url.hostname,
          TARGET_PATH: path,
          BROKER_HOST: this.brokerHost,
          MAX_BYTES: String(this.maxBytes),
          WATCH_URL: v.url.href,
          ...extraEnv,
        },
      )
      .then((result) => {
        if (result.timedOut) throw new Error('web fetch timed out');
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `${script} exit ${result.exitCode}`);
        }
        return result.stdout.trim();
      });
  }

  async fetch(url: string): Promise<string> {
    return this.runScript('fetch.sh', url);
  }

  async watch(url: string): Promise<string> {
    if (this.workspaceDir === undefined) {
      throw new Error('watch requires sandbox workspace mount');
    }
    return this.runScript('watch.sh', url, { WATCH_DIR: '/workspace/watch' });
  }

  private runFinanceScript(
    script: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    if (this.workspaceDir === undefined) {
      throw new Error('finance requires sandbox workspace mount');
    }
    return this.runner
      .run(
        this.financeDir,
        script,
        {
          timeoutMs: 30_000,
          memoryBytes: 64 * 1024 * 1024,
          allowedHosts: [],
        },
        extraEnv,
      )
      .then((result) => {
        if (result.timedOut) throw new Error('finance script timed out');
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `${script} exit ${result.exitCode}`);
        }
        return result.stdout.trim();
      });
  }

  async financeIngest(bodies: string): Promise<string> {
    const finDir = join(this.workspaceDir!, 'finance');
    mkdirSync(finDir, { recursive: true });
    writeFileSync(join(finDir, '.ingest-buffer.txt'), bodies, 'utf8');
    return this.runFinanceScript('parse_finance.sh', {
      FINANCE_INPUT: '/workspace/finance/.ingest-buffer.txt',
    });
  }

  async financeReport(month?: string): Promise<string> {
    const env: Record<string, string> = {};
    if (month !== undefined) env.FINANCE_MONTH = month;
    return this.runFinanceScript('report_finance.sh', env);
  }
}

/** Тестовый/интеграционный fetcher без Docker. */
export class StaticWebFetcher implements WebFetcher {
  private readonly watchCalls = new Map<string, number>();

  constructor(
    private readonly pages: Record<string, string>,
    private readonly watchSeq: Record<string, string[]> = {},
    private readonly finance?: {
      ingest: (bodies: string) => string;
      report: (month?: string) => string;
    },
  ) {}

  async fetch(url: string): Promise<string> {
    const v = validateFetchUrl(url);
    if (!v.ok) throw new Error(v.reason);
    const body = this.pages[url] ?? this.pages[v.url.href];
    if (body === undefined) throw new Error('page not found in static fetcher');
    return body;
  }

  async watch(url: string): Promise<string> {
    const v = validateFetchUrl(url);
    if (!v.ok) throw new Error(v.reason);
    const href = v.url.href;
    const seq = this.watchSeq[href] ?? this.watchSeq[url];
    if (seq === undefined || seq.length === 0) throw new Error('page not found in static watch sequence');
    const n = this.watchCalls.get(href) ?? 0;
    this.watchCalls.set(href, n + 1);
    if (n === 0) return `WATCH_OK: baseline saved (${href})`;
    const prev = seq[n - 1] ?? seq[0]!;
    const cur = seq[n] ?? seq[seq.length - 1]!;
    return prev === cur ? 'WATCH_OK: unchanged' : `WATCH_CHANGED: page content changed (${href})`;
  }

  async financeIngest(bodies: string): Promise<string> {
    if (!this.finance) throw new Error('finance not configured in static fetcher');
    return this.finance.ingest(bodies);
  }

  async financeReport(month?: string): Promise<string> {
    if (!this.finance) throw new Error('finance not configured in static fetcher');
    return this.finance.report(month);
  }
}
