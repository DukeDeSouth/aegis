/**
 * ADR-0010 (Sprint 24, P-B): OAuth-refresh sidecar в trust-домене broker.
 * Читает refresh-token из файла, обновляет access-token и атомарно пишет его
 * в SDS-yaml для Envoy credential_injector. Токены НИКОГДА не попадают в лог.
 *
 * Env:
 *   OAUTH_CREDS_FILE  — json {client_id, client_secret, refresh_token} (обязателен)
 *   OAUTH_SDS_OUT     — путь SDS-yaml для Envoy (обязателен)
 *   OAUTH_TOKEN_URL   — token endpoint (default: Google)
 *   OAUTH_SECRET_NAME — имя SDS-секрета (default: google_token)
 *   OAUTH_ONE_SHOT    — '1': один refresh и exit 0/1 (тесты, health-check)
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const TOKEN_URL = process.env.OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const CREDS_FILE = process.env.OAUTH_CREDS_FILE ?? '/etc/oauth/google-oauth.json';
const SDS_OUT = process.env.OAUTH_SDS_OUT ?? '/etc/broker-oauth/google-secret.yaml';
const SECRET_NAME = process.env.OAUTH_SECRET_NAME ?? 'google_token';
const ONE_SHOT = process.env.OAUTH_ONE_SHOT === '1';
const RETRY_MS = 30_000;

function sdsYaml(accessToken) {
  // Одинарные кавычки YAML: единственный спецсимвол — сама кавычка.
  const quoted = `'${String(accessToken).replaceAll("'", "''")}'`;
  return [
    '# Генерируется oauth-sidecar (ADR-0010). Не редактировать вручную.',
    'resources:',
    "  - '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret",
    `    name: ${SECRET_NAME}`,
    '    generic_secret:',
    '      secret:',
    `        inline_string: ${quoted}`,
    '',
  ].join('\n');
}

async function refreshOnce() {
  const creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  for (const k of ['client_id', 'client_secret', 'refresh_token']) {
    if (typeof creds[k] !== 'string' || creds[k].length === 0) {
      throw new Error(`creds file: missing ${k}`);
    }
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  // Тело ответа не логируем: при ошибке Google кладёт туда описание, при
  // успехе — сам токен. Наружу уходит только статус.
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('token endpoint: no access_token in response');
  }
  const expiresIn = Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 3600;
  const tmp = `${SDS_OUT}.tmp`;
  writeFileSync(tmp, sdsYaml(data.access_token), { mode: 0o600 });
  renameSync(tmp, SDS_OUT); // атомарно: Envoy SDS ловит move, частичных чтений нет
  console.log(`refreshed ${SECRET_NAME}, expires_in=${expiresIn}s`);
  return expiresIn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (ONE_SHOT) {
  try {
    await refreshOnce();
    process.exit(0);
  } catch (err) {
    console.error(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

for (;;) {
  try {
    const expiresIn = await refreshOnce();
    await sleep(expiresIn * 0.9 * 1000);
  } catch (err) {
    console.error(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    await sleep(RETRY_MS);
  }
}
