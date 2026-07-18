/**
 * web.fetch: загрузка через sandbox + broker (F2). Ядро не держит HTTP-клиент.
 */
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SandboxRunner } from '../../sandbox/types.ts';
import { resolveWorkspacePath } from '../workspace.ts';
import { validateFetchUrl } from './url.ts';

const DEFAULT_SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../skills/web-fetch');
const DEFAULT_FINANCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../connectors/finance');
const DEFAULT_TRAVEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../connectors/travel');
const DEFAULT_MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../skills/media-pipeline');

export interface WebFetcher {
  fetch(url: string): Promise<string>;
  watch?(url: string): Promise<string>;
  financeIngest?(bodies: string): Promise<string>;
  financeReport?(month?: string): Promise<string>;
  travelIngest?(bodies: string): Promise<string>;
  travelBrief?(flightIata?: string): Promise<string>;
  mediaTranscode?(relPath: string, withSubs?: boolean): Promise<string>;
}

export interface WebFetchConfig {
  brokerHost: string;
  maxResponseBytes: number;
  skillDir?: string;
  financeDir?: string;
  travelDir?: string;
  mediaSkillDir?: string;
  mediaImage?: string;
  workspaceDir?: string;
}

export class SandboxWebFetcher implements WebFetcher {
  private readonly runner: SandboxRunner;
  private readonly brokerHost: string;
  private readonly maxBytes: number;
  private readonly skillDir: string;
  private readonly financeDir: string;
  private readonly travelDir: string;
  private readonly mediaSkillDir: string;
  private readonly mediaImage: string | undefined;
  private readonly workspaceDir: string | undefined;

  constructor(runner: SandboxRunner, config: WebFetchConfig) {
    this.runner = runner;
    this.brokerHost = config.brokerHost;
    this.maxBytes = config.maxResponseBytes;
    this.skillDir = config.skillDir ?? DEFAULT_SKILL_DIR;
    this.financeDir = config.financeDir ?? DEFAULT_FINANCE_DIR;
    this.travelDir = config.travelDir ?? DEFAULT_TRAVEL_DIR;
    this.mediaSkillDir = config.mediaSkillDir ?? DEFAULT_MEDIA_DIR;
    this.mediaImage = config.mediaImage;
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

  private runConnectorScript(
    connectorDir: string,
    script: string,
    extraEnv: Record<string, string> = {},
    allowedHosts: string[] = [],
  ): Promise<string> {
    if (this.workspaceDir === undefined) {
      throw new Error('connector script requires sandbox workspace mount');
    }
    return this.runner
      .run(
        connectorDir,
        script,
        {
          timeoutMs: 30_000,
          memoryBytes: 64 * 1024 * 1024,
          allowedHosts,
        },
        extraEnv,
      )
      .then((result) => {
        if (result.timedOut) throw new Error(`${script} timed out`);
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
    return this.runConnectorScript(this.financeDir, 'parse_finance.sh', {
      FINANCE_INPUT: '/workspace/finance/.ingest-buffer.txt',
    });
  }

  async financeReport(month?: string): Promise<string> {
    const env: Record<string, string> = {};
    if (month !== undefined) env.FINANCE_MONTH = month;
    return this.runConnectorScript(this.financeDir, 'report_finance.sh', env);
  }

  async travelIngest(bodies: string): Promise<string> {
    const travelDir = join(this.workspaceDir!, 'travel');
    mkdirSync(travelDir, { recursive: true });
    writeFileSync(join(travelDir, '.ingest-buffer.txt'), bodies, 'utf8');
    return this.runConnectorScript(this.travelDir, 'parse_travel.sh', {
      TRAVEL_INPUT: '/workspace/travel/.ingest-buffer.txt',
    });
  }

  async travelBrief(flightIata?: string): Promise<string> {
    if (flightIata !== undefined) {
      const brokerHost = this.brokerHost.split(':')[0] ?? this.brokerHost;
      const line = await this.runConnectorScript(
        this.travelDir,
        'fetch_flight.sh',
        {
          TRAVEL_FLIGHT_IATA: flightIata,
          TRAVEL_BROKER_HOST: `${brokerHost}:8087`,
          BROKER_HOST: `${brokerHost}:8087`,
          TRAVEL_MOCK: process.env.TRAVEL_MOCK ?? '',
        },
        [brokerHost],
      );
      if (!line.startsWith('TRAVEL_FLIGHT_OK:')) {
        throw new Error(line.startsWith('TRAVEL_FLIGHT_ERROR:') ? line : `unexpected flight output: ${line}`);
      }
    }
    return this.runConnectorScript(this.travelDir, 'build_brief.sh');
  }

  private runMediaScript(
    script: string,
    relPath: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    if (this.workspaceDir === undefined) {
      throw new Error('media transcode requires sandbox workspace mount');
    }
    resolveWorkspacePath(this.workspaceDir, relPath);
    return this.runner
      .run(
        this.mediaSkillDir,
        script,
        {
          timeoutMs: 300_000,
          memoryBytes: 512 * 1024 * 1024,
          allowedHosts: [],
          workspaceDir: this.workspaceDir,
        },
        { INPUT_PATH: relPath, MEDIA_MOCK: process.env.MEDIA_MOCK ?? '', ...extraEnv },
        this.mediaImage !== undefined ? { image: this.mediaImage } : undefined,
      )
      .then((result) => {
        if (result.timedOut) throw new Error('media script timed out');
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `${script} exit ${result.exitCode}`);
        }
        return result.stdout.trim();
      });
  }

  async mediaTranscode(relPath: string, withSubs = false): Promise<string> {
    const line = await this.runMediaScript('transcode.sh', relPath);
    if (!withSubs) return line;
    const subs = await this.runMediaScript('subtitles.sh', relPath);
    return `${line}\nSRT:\n${subs}`;
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
    private readonly media?: {
      transcode: (relPath: string, withSubs?: boolean) => string;
    },
    private readonly travel?: {
      ingest: (bodies: string) => string;
      brief: (flightIata?: string) => string;
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

  async travelIngest(bodies: string): Promise<string> {
    if (!this.travel) throw new Error('travel not configured in static fetcher');
    return this.travel.ingest(bodies);
  }

  async travelBrief(flightIata?: string): Promise<string> {
    if (!this.travel) throw new Error('travel not configured in static fetcher');
    return this.travel.brief(flightIata);
  }

  async mediaTranscode(relPath: string, withSubs = false): Promise<string> {
    if (!this.media) throw new Error('media not configured in static fetcher');
    return this.media.transcode(relPath, withSubs);
  }
}
