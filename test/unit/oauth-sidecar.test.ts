/**
 * Sprint 24 / P-B (ADR-0010): oauth-sidecar — refresh-grant против фейкового
 * token-endpoint, атомарная запись SDS-yaml, отсутствие токенов в логах.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const SIDECAR = join(process.cwd(), 'deploy', 'broker', 'oauth-sidecar', 'sidecar.mjs');
const REFRESH_TOKEN = '1//refresh-secret-value';
const ACCESS_TOKEN = 'ya29.access-secret-value';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-oauth-sidecar-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function startTokenEndpoint(
  handler: (body: URLSearchParams) => { status: number; json: unknown },
): Promise<{ url: string; requests: URLSearchParams[] }> {
  const requests: URLSearchParams[] = [];
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        requests.push(body);
        const { status, json } = handler(body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server!.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/token`, requests });
    });
  });
}

function writeCreds(): string {
  const file = join(tmp, `creds-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    file,
    JSON.stringify({ client_id: 'cid', client_secret: 'csec', refresh_token: REFRESH_TOKEN }),
  );
  return file;
}

async function runOneShot(tokenUrl: string, credsFile: string, outFile: string) {
  try {
    const { stdout, stderr } = await execFileP('node', [SIDECAR], {
      env: {
        ...process.env,
        OAUTH_TOKEN_URL: tokenUrl,
        OAUTH_CREDS_FILE: credsFile,
        OAUTH_SDS_OUT: outFile,
        OAUTH_ONE_SHOT: '1',
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('oauth-sidecar (ADR-0010)', () => {
  it('refresh-grant → SDS-yaml с access-token, refresh-token уходит только на endpoint', async () => {
    const { url, requests } = await startTokenEndpoint(() => ({
      status: 200,
      json: { access_token: ACCESS_TOKEN, expires_in: 3599 },
    }));
    const out = join(tmp, 'google-secret.yaml');
    const res = await runOneShot(url, writeCreds(), out);

    expect(res.code).toBe(0);
    const sds = readFileSync(out, 'utf8');
    expect(sds).toContain('name: google_token');
    expect(sds).toContain(`inline_string: '${ACCESS_TOKEN}'`);
    expect(sds).toContain('generic_secret');
    // Запрос корректный refresh-grant:
    expect(requests[0]!.get('grant_type')).toBe('refresh_token');
    expect(requests[0]!.get('refresh_token')).toBe(REFRESH_TOKEN);
  });

  it('V2: токены отсутствуют в stdout/stderr', async () => {
    const { url } = await startTokenEndpoint(() => ({
      status: 200,
      json: { access_token: ACCESS_TOKEN, expires_in: 100 },
    }));
    const res = await runOneShot(url, writeCreds(), join(tmp, 'out-v2.yaml'));

    const logs = res.stdout + res.stderr;
    expect(logs).toContain('refreshed google_token, expires_in=100s');
    expect(logs).not.toContain(ACCESS_TOKEN);
    expect(logs).not.toContain(REFRESH_TOKEN);
    expect(logs).not.toContain('csec');
  });

  it('HTTP 500 от endpoint → exit 1, тело ответа не логируется', async () => {
    const { url } = await startTokenEndpoint(() => ({
      status: 500,
      json: { error: 'invalid_grant', secret_echo: REFRESH_TOKEN },
    }));
    const out = join(tmp, 'out-err.yaml');
    const res = await runOneShot(url, writeCreds(), out);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('HTTP 500');
    expect(res.stdout + res.stderr).not.toContain(REFRESH_TOKEN);
    expect(() => readFileSync(out, 'utf8')).toThrow(); // SDS-файл не создан
  });

  it('ответ без access_token → exit 1', async () => {
    const { url } = await startTokenEndpoint(() => ({ status: 200, json: { expires_in: 60 } }));
    const res = await runOneShot(url, writeCreds(), join(tmp, 'out-empty.yaml'));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('no access_token');
  });

  it('битый creds-файл (нет refresh_token) → exit 1 без запроса', async () => {
    const { url, requests } = await startTokenEndpoint(() => ({ status: 200, json: {} }));
    const file = join(tmp, 'creds-broken.json');
    writeFileSync(file, JSON.stringify({ client_id: 'cid', client_secret: 'csec' }));
    const res = await runOneShot(url, file, join(tmp, 'out-broken.yaml'));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('missing refresh_token');
    expect(requests.length).toBe(0);
  });

  it('токен с одинарной кавычкой экранируется в YAML', async () => {
    const tricky = "tok'en";
    const { url } = await startTokenEndpoint(() => ({
      status: 200,
      json: { access_token: tricky, expires_in: 60 },
    }));
    const out = join(tmp, 'out-quote.yaml');
    const res = await runOneShot(url, writeCreds(), out);
    expect(res.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain("inline_string: 'tok''en'");
  });
});
