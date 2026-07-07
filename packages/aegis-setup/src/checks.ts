import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type ExecFn = typeof exec;

export async function checkNodeVersion(minMajor = 24): Promise<{ ok: true } | { ok: false; reason: string }> {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < minMajor) {
    return { ok: false, reason: `Node >= ${minMajor} required (current ${process.version})` };
  }
  return { ok: true };
}

export async function checkDocker(run: ExecFn = exec): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run('docker', ['info'], { timeout: 15_000 });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Docker not available: ${msg}` };
  }
}

export async function checkBrokerRunning(
  composeDir: string,
  run: ExecFn = exec,
): Promise<{ ok: true } | { ok: false; reason: string } | { ok: true; skipped: true }> {
  try {
    const { stdout } = await run('docker', ['compose', 'ps', '--status', 'running', '--format', '{{.Service}}'], {
      cwd: composeDir,
      timeout: 15_000,
    });
    if (!stdout.includes('broker')) {
      return { ok: false, reason: 'broker service not running (cd deploy && docker compose up -d broker)' };
    }
    return { ok: true };
  } catch {
    return { ok: true, skipped: true };
  }
}

export async function checkTelegramToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (token.length < 10) return { ok: false, reason: 'AEGIS_TG_BOT_TOKEN empty or too short' };
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/getMe`);
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (!body.ok) return { ok: false, reason: `Telegram getMe failed: ${body.description ?? res.status}` };
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Telegram API unreachable: ${msg}` };
  }
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
