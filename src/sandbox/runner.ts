/**
 * DockerSandboxRunner — единственная реализация SandboxRunner в MVP (ADR-0006).
 *
 * Hardened-профиль — константы, а не параметры: ослабить его через API нельзя.
 * Сеть выводится из allowedHosts: пустой список — `--network none` (сети нет);
 * непустой — internal-сеть с брокером, а allowlist хостов enforce'ится на
 * брокере (маршруты Envoy), не здесь. Runner не знает о секретах и политике.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { SandboxLimits, SandboxRunner, SandboxRunResult } from './types.ts';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (argv: string[]) => Promise<ExecResult>;

export type SandboxRuntime = 'docker' | 'gvisor';

export interface DockerSandboxOptions {
  /** Образ sandbox, пиннится как tag@digest. */
  image: string;
  /** Internal-сеть с брокером (docker network --internal). */
  internalNetwork: string;
  /** F4: rw-mount workspace в контейнер как /workspace. */
  workspaceDir?: string;
  /** gVisor runsc (Linux); default docker — hardened-профиль тот же. */
  runtime?: SandboxRuntime;
  /** Инжектируется в тестах; по умолчанию — execFile('docker', ...). */
  exec?: ExecFn;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Ненулевой exit code внутри sandbox — данные, не ошибка: не reject'им. */
export function defaultExec(argv: string[]): Promise<ExecResult> {
  return new Promise((res, rej) => {
    execFile('docker', argv, { maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        rej(new Error(`docker ${argv[0] ?? ''}: ${err.message}`));
        return;
      }
      res({ exitCode: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
    });
  });
}

/** Чистая сборка argv `docker run` — hardened-профиль ADR-0006 целиком. */
export function buildRunArgs(opts: {
  name: string;
  skillDir: string;
  entrypoint: string;
  limits: SandboxLimits;
  image: string;
  internalNetwork: string;
  workspaceDir?: string;
  runtime?: SandboxRuntime;
  env?: Record<string, string>;
  extraMounts?: readonly { hostPath: string; containerPath: string; readOnly?: boolean }[];
}): string[] {
  const { name, skillDir, entrypoint, limits, image, internalNetwork, workspaceDir, extraMounts } =
    opts;
  if (entrypoint.split('/').includes('..') || isAbsolute(entrypoint)) {
    throw new Error(`sandbox: entrypoint must be a relative path inside skillDir`);
  }
  const network = limits.allowedHosts.length === 0 ? 'none' : internalNetwork;
  const args = ['run'];
  if (opts.runtime === 'gvisor') {
    args.push('--runtime', 'runsc');
  }
  args.push(
    '--rm',
    '--name',
    name,
    '--network',
    network,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--memory',
    String(limits.memoryBytes),
    '--memory-swap',
    String(limits.memoryBytes),
    '--cpus',
    '1',
    '--pids-limit',
    '64',
    '-v',
    `${resolve(skillDir)}:/skill:ro`,
  );
  if (workspaceDir) {
    args.push('-v', `${resolve(workspaceDir)}:/workspace:rw`);
  }
  for (const m of extraMounts ?? []) {
    const ro = m.readOnly !== false ? ':ro' : '';
    args.push('-v', `${resolve(m.hostPath)}:${m.containerPath}${ro}`);
  }
  args.push(
    '--workdir',
    '/skill',
  );
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(image, '/bin/sh', `/skill/${entrypoint}`);
  return args;
}

export class DockerSandboxRunner implements SandboxRunner {
  private readonly image: string;
  private readonly internalNetwork: string;
  private readonly workspaceDir: string | undefined;
  private readonly runtime: SandboxRuntime;
  private readonly exec: ExecFn;

  constructor(opts: DockerSandboxOptions) {
    this.image = opts.image;
    this.internalNetwork = opts.internalNetwork;
    this.workspaceDir = opts.workspaceDir;
    this.runtime = opts.runtime ?? 'docker';
    this.exec = opts.exec ?? defaultExec;
  }

  async run(
    skillDir: string,
    entrypoint: string,
    limits: SandboxLimits,
    env?: Record<string, string>,
    opts?: import('./types.ts').SandboxRunOptions,
  ): Promise<SandboxRunResult> {
    const name = `aegis-sb-${randomBytes(6).toString('hex')}`;
    const argv = buildRunArgs({
      name,
      skillDir,
      entrypoint,
      limits,
      image: opts?.image ?? this.image,
      internalNetwork: this.internalNetwork,
      runtime: this.runtime,
      ...(this.workspaceDir !== undefined ? { workspaceDir: this.workspaceDir } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(opts?.extraMounts !== undefined ? { extraMounts: opts.extraMounts } : {}),
    });
    let timedOut = false;
    // Контейнера может уже не быть (гонка kill/exit) — ошибка kill безопасно глотается.
    const timer = setTimeout(() => {
      timedOut = true;
      void this.exec(['kill', name]).catch(() => undefined);
    }, limits.timeoutMs);
    try {
      const r = await this.exec(argv);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}
