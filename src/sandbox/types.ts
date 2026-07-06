/**
 * Контракт исполнения кода навыков (ADR-0006: hardened Docker в MVP,
 * интерфейс не привязан к рантайму — upgrade path gVisor/microVM без смены типа).
 */

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
  /** Хосты, разрешённые манифестом навыка; пустой список = сеть отрезана. */
  allowedHosts: string[];
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxRunner {
  run(skillDir: string, entrypoint: string, limits: SandboxLimits): Promise<SandboxRunResult>;
}
