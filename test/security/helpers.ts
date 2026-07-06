/**
 * Утилиты security-тестов (V2/V3): единственный контур, которому нужен Docker.
 * Без Docker сьюты скипаются (describe.skipIf), а не падают и не зеленеют молча.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Пины образов (tag@digest). Обновление — осознанное действие с прогоном test:security. */
export const ALPINE =
  'alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce';
export const NODE =
  'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';
/** >= v1.36: header_value_prefix у Generic credential (deploy/broker/README.md). */
export const ENVOY =
  'envoyproxy/envoy:v1.37.1@sha256:29496a88fba9c4c9cdef4afe8fec70f536c5ba111b1c2bddbc5436b091ceca33';

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Ненулевой exit — данные проверки, не исключение. */
export function docker(argv: string[]): Promise<DockerResult> {
  return new Promise((res, rej) => {
    execFile('docker', argv, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        rej(new Error(`docker ${argv[0] ?? ''} failed to start: ${err.message}`));
        return;
      }
      res({ exitCode: err && typeof err.code === 'number' ? err.code : 0, stdout, stderr });
    });
  });
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    return (await docker(['info'])).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Каталог для mounts: realpath обязателен — на macOS tmpdir лежит за симлинком
 * /var → /private/var, а Docker Desktop шарит только реальный путь.
 * chmod 0755 обязателен для нативного Linux (CI): mkdtemp даёт 0700, а контейнеры
 * читают mount под непривилегированным uid (65534 / envoy) — иначе exit 2.
 */
export function mountableTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  chmodSync(dir, 0o755);
  return dir;
}

/** Снос контейнеров и сетей по префиксу: и до (следы упавших прогонов), и после. */
export async function cleanupByPrefix(prefix: string): Promise<void> {
  const ps = await docker(['ps', '-aq', '--filter', `name=${prefix}`]);
  const ids = ps.stdout.trim().split('\n').filter(Boolean);
  if (ids.length > 0) await docker(['rm', '-f', ...ids]);
  const nets = await docker(['network', 'ls', '-q', '--filter', `name=${prefix}`]);
  const netIds = nets.stdout.trim().split('\n').filter(Boolean);
  for (const id of netIds) await docker(['network', 'rm', id]);
}

/** Активный поллинг вместо sleep: пробуем действие до успеха или дедлайна. */
export async function pollUntil(
  action: () => Promise<boolean>,
  { timeoutMs = 30_000, intervalMs = 500 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await action()) return;
    if (Date.now() > deadline) throw new Error('pollUntil: deadline exceeded');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
