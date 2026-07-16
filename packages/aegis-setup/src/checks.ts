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

/** Sprint 26: smoke broker — 401 без OAuth-креда, 404 на неизвестный Host (если broker поднят). */
export async function checkBrokerSmoke(
  composeDir: string,
  envoyYaml: string,
  run: ExecFn = exec,
): Promise<{ ok: true; detail: string } | { ok: false; reason: string } | { ok: true; skipped: true }> {
  try {
    const { stdout: cidOut } = await run('docker', ['compose', 'ps', '-q', 'broker'], {
      cwd: composeDir,
      timeout: 15_000,
    });
    const cid = cidOut.trim();
    if (cid.length === 0) return { ok: true, skipped: true };

    const { stdout: netJson } = await run('docker', ['inspect', cid, '--format', '{{json .NetworkSettings.Networks}}'], {
      timeout: 15_000,
    });
    const nets = Object.keys(JSON.parse(netJson) as Record<string, unknown>);
    const network = nets.find((n) => n.includes('internal')) ?? nets[0];
    if (network === undefined) return { ok: false, reason: 'broker network not found' };

    const curl = (host: string, port: number, logicalHost: string): Promise<string> =>
      run(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          network,
          'curlimages/curl:8.5.0',
          '-s',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          '-H',
          `Host: ${logicalHost}`,
          `http://${host}:${port}/`,
        ],
        { timeout: 25_000 },
      ).then((r) => r.stdout.trim());

    const oauthPort = envoyYaml.includes('conn-google-listener') ? 8081 : undefined;
    const parts: string[] = [];

    if (oauthPort !== undefined) {
      const code401 = await curl('broker', oauthPort, 'gmail.googleapis.com');
      if (code401 !== '401') {
        return { ok: false, reason: `OAuth listener :${oauthPort} expected 401 without cred, got ${code401}` };
      }
      parts.push(`401 on :${oauthPort}`);
    }

    const code404 = await curl('broker', 8080, 'evil.not-in-allowlist.test');
    if (code404 !== '404') {
      return { ok: false, reason: `broker :8080 expected 404 on unknown Host, got ${code404}` };
    }
    parts.push('404 on unknown Host');

    return { ok: true, detail: parts.join(', ') };
  } catch {
    return { ok: true, skipped: true };
  }
}
