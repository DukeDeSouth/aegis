/**
 * Sprint 23 (P-C): connector add|list — установка пресетов, идемпотентный envoy-merge.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyConnector,
  checkEnvoyRoutes,
  connectorStatus,
  listPresets,
  loadPreset,
  mergeEnvoy,
  marker,
  removeConnectorBlocks,
  upgradeConnector,
} from '../src/connector.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = mkdtempSync(join(tmpdir(), 'aegis-connector-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Свежий "clone": реальные connectors/ + реальный broker-шаблон. */
function makeRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(join(root, 'deploy', 'broker'), { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  cpSync(join(REPO_ROOT, 'connectors'), join(root, 'connectors'), { recursive: true });
  cpSync(
    join(REPO_ROOT, 'deploy', 'broker', 'envoy.yaml'),
    join(root, 'deploy', 'broker', 'envoy.yaml'),
  );
  return root;
}

describe('connector presets', () => {
  it('репо содержит пресеты волн 1 и 2', () => {
    const names = listPresets(join(REPO_ROOT, 'connectors'));
    expect(names).toEqual(['github', 'google', 'homeassistant', 'notes', 'rss', 'search', 'watch', 'weather']);
  });

  it('add устанавливает skill и broker-маршруты; повторный add — no-op', () => {
    const root = makeRoot('r1');
    const preset = loadPreset(join(root, 'connectors'), 'weather');

    const first = applyConnector(root, preset);
    expect(first.skillInstalled).toBe(true);
    expect(first.routesAdded).toBe(1);
    expect(existsSync(join(root, 'skills', 'weather', 'manifest.json'))).toBe(true);

    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(envoy).toContain(marker('weather'));
    expect(envoy).toContain("domains: ['api.open-meteo.com', 'api.open-meteo.com:*']");
    expect(envoy).toContain('sni: api.open-meteo.com');

    const second = applyConnector(root, preset);
    expect(second.skillInstalled).toBe(false);
    expect(second.routesAdded).toBe(0);
    expect(readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8')).toBe(envoy);
  });

  it('plain-HTTP маршрут (searxng) без transport_socket', () => {
    const root = makeRoot('r2');
    applyConnector(root, loadPreset(join(root, 'connectors'), 'search'));
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    const start = envoy.indexOf('# connector:search', envoy.indexOf('clusters:'));
    const block = envoy.slice(start, envoy.indexOf('port_value: 8080 }', start));
    expect(block).toContain('- name: conn-search-0');
    expect(block).not.toContain('transport_socket');
  });

  it('notes: только skill, envoy не тронут', () => {
    const root = makeRoot('r3');
    const before = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    const res = applyConnector(root, loadPreset(join(root, 'connectors'), 'notes'));
    expect(res.skillInstalled).toBe(true);
    expect(res.routesAdded).toBe(0);
    expect(readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8')).toBe(before);
  });

  it('status: available → installed', () => {
    const root = makeRoot('r4');
    expect(connectorStatus(root, 'rss')).toBe('available');
    applyConnector(root, loadPreset(join(root, 'connectors'), 'rss'));
    expect(connectorStatus(root, 'rss')).toBe('installed');
  });

  it('неизвестный пресет и битое имя — ошибка', () => {
    const root = makeRoot('r5');
    expect(() => loadPreset(join(root, 'connectors'), 'nope')).toThrow('unknown connector');
    expect(() => loadPreset(join(root, 'connectors'), '../evil')).toThrow('invalid connector name');
  });

  it('mergeEnvoy падает на чужом шаблоне (fail-closed)', () => {
    const preset = loadPreset(join(REPO_ROOT, 'connectors'), 'weather');
    expect(() => mergeEnvoy('foo: bar\n', preset)).toThrow('anchor not found');
  });

  it('google (Sprint 24): отдельный listener :8081 со своим SDS-секретом; повторный add — no-op', () => {
    const root = makeRoot('r7');
    const preset = loadPreset(join(root, 'connectors'), 'google');

    const first = applyConnector(root, preset);
    expect(first.skillInstalled).toBe(true);
    expect(first.routesAdded).toBe(2);

    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(envoy).toContain('# connector:google listener');
    expect(envoy).toContain('- name: conn-google-listener');
    expect(envoy).toContain('port_value: 8081');
    expect(envoy).toContain('name: google_token');
    expect(envoy).toContain('path: /etc/broker/oauth/google-secret.yaml');
    expect(envoy).toContain("domains: ['gmail.googleapis.com', 'gmail.googleapis.com:*']");
    expect(envoy).toContain("domains: ['www.googleapis.com', 'www.googleapis.com:*']");
    expect(envoy).toContain('sni: gmail.googleapis.com');
    // Изоляция секретов: broker_token из :8080 не упоминается в google-listener.
    const listenerBlock = envoy.slice(
      envoy.indexOf('# connector:google listener'),
      envoy.indexOf('- name: llm'),
    );
    expect(listenerBlock).not.toContain('broker_token');
    expect(checkEnvoyRoutes(envoy).ok).toBe(true);

    const second = applyConnector(root, preset);
    expect(second.routesAdded).toBe(0);
    expect(readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8')).toBe(envoy);
  });

  it('google: пресет ставится рядом с волной 1 без конфликтов', () => {
    const root = makeRoot('r8');
    for (const name of ['weather', 'search', 'google']) {
      applyConnector(root, loadPreset(join(root, 'connectors'), name));
    }
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(checkEnvoyRoutes(envoy).ok).toBe(true);
    expect(envoy).toContain('conn-weather-0');
    expect(envoy).toContain('conn-search-0');
    expect(envoy).toContain('conn-google-0');
    expect(envoy).toContain('conn-google-1');
  });

  it('checkEnvoyRoutes: удалённый cluster google-listener — FAIL', () => {
    const root = makeRoot('r9');
    applyConnector(root, loadPreset(join(root, 'connectors'), 'google'));
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    const broken = envoy.replace(/cluster_name: conn-google-0/, 'cluster_name: conn-google-x');
    const res = checkEnvoyRoutes(broken);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('conn-google-0');
  });

  it('битый broker_listener в connector.json — ошибка загрузки', () => {
    const root = makeRoot('r10');
    const dir = join(root, 'connectors', 'google');
    const meta = JSON.parse(readFileSync(join(dir, 'connector.json'), 'utf8'));
    meta.broker_listener.routes = [];
    writeFileSync(join(dir, 'connector.json'), JSON.stringify(meta));
    expect(() => loadPreset(join(root, 'connectors'), 'google')).toThrow(
      'malformed broker_listener',
    );
  });

  it('homeassistant (Sprint 25): listener :8082, ha_token изолирован от broker_token', () => {
    const root = makeRoot('r11');
    const preset = loadPreset(join(root, 'connectors'), 'homeassistant');
    applyConnector(root, preset);
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(envoy).toContain('# connector:homeassistant listener');
    expect(envoy).toContain('port_value: 8082');
    expect(envoy).toContain('name: ha_token');
    expect(envoy).toContain('path: /etc/broker/ha/secret.yaml');
    expect(envoy).toContain("domains: ['homeassistant.local', 'homeassistant.local:*']");
    const listenerBlock = envoy.slice(
      envoy.indexOf('# connector:homeassistant listener'),
      envoy.indexOf('- name: llm'),
    );
    expect(listenerBlock).not.toContain('broker_token');
    expect(checkEnvoyRoutes(envoy).ok).toBe(true);
  });

  it('github (Sprint 25): listener :8083, github_token изолирован', () => {
    const root = makeRoot('r12');
    const preset = loadPreset(join(root, 'connectors'), 'github');
    applyConnector(root, preset);
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(envoy).toContain('# connector:github listener');
    expect(envoy).toContain('port_value: 8083');
    expect(envoy).toContain('name: github_token');
    expect(envoy).toContain('path: /etc/broker/github/secret.yaml');
    expect(envoy).toContain("domains: ['api.github.com', 'api.github.com:*']");
    const listenerBlock = envoy.slice(
      envoy.indexOf('# connector:github listener'),
      envoy.indexOf('- name: llm'),
    );
    expect(listenerBlock).not.toContain('broker_token');
    expect(checkEnvoyRoutes(envoy).ok).toBe(true);
  });

  it('волна 1 + C4/C5: google, homeassistant, github без конфликтов портов', () => {
    const root = makeRoot('r13');
    for (const name of ['weather', 'google', 'homeassistant', 'github']) {
      applyConnector(root, loadPreset(join(root, 'connectors'), name));
    }
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(checkEnvoyRoutes(envoy).ok).toBe(true);
    expect(envoy).toContain('port_value: 8081');
    expect(envoy).toContain('port_value: 8082');
    expect(envoy).toContain('port_value: 8083');
  });

  it('checkEnvoyRoutes: валидный merge — ok, битый маршрут — FAIL', () => {
    const root = makeRoot('r6');
    applyConnector(root, loadPreset(join(root, 'connectors'), 'weather'));
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(checkEnvoyRoutes(envoy).ok).toBe(true);

    // Владелец руками удалил cluster-блок, оставив route.
    const broken = envoy.replace(/cluster_name: conn-weather-0/, 'cluster_name: conn-weather-x');
    const res = checkEnvoyRoutes(broken);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('conn-weather-0');
  });

  it('watch (Sprint 26): skill-only preset, envoy не тронут', () => {
    const root = makeRoot('r14');
    const before = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    const res = applyConnector(root, loadPreset(join(root, 'connectors'), 'watch'));
    expect(res.skillInstalled).toBe(true);
    expect(res.routesAdded).toBe(0);
    expect(readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8')).toBe(before);
  });

  it('upgrade: перезаписывает skill и идемпотентен', () => {
    const root = makeRoot('r15');
    applyConnector(root, loadPreset(join(root, 'connectors'), 'weather'));
    writeFileSync(join(root, 'skills', 'weather', 'SKILL.md'), '# stale\n');

    const first = upgradeConnector(root, loadPreset(join(root, 'connectors'), 'weather'));
    expect(first.skillUpdated).toBe(true);
    expect(readFileSync(join(root, 'skills', 'weather', 'SKILL.md'), 'utf8')).toContain('Weather');

    const envoyAfter = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    expect(checkEnvoyRoutes(envoyAfter).ok).toBe(true);

    const second = upgradeConnector(root, loadPreset(join(root, 'connectors'), 'weather'));
    expect(second.skillUpdated).toBe(false);
    expect(second.routesUpdated).toBe(0);
    expect(second.envoyDiff).toEqual([]);
    expect(readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8')).toBe(envoyAfter);
  });

  it('removeConnectorBlocks удаляет маркерные блоки', () => {
    const root = makeRoot('r16');
    applyConnector(root, loadPreset(join(root, 'connectors'), 'weather'));
    const envoy = readFileSync(join(root, 'deploy', 'broker', 'envoy.yaml'), 'utf8');
    const stripped = removeConnectorBlocks(envoy, 'weather');
    expect(stripped).not.toContain(marker('weather'));
    expect(stripped).not.toContain('conn-weather-0');
  });
});
