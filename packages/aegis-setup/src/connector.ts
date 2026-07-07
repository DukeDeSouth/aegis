/**
 * Sprint 23 (CONNECTORS.md P-C): `aegis-setup connector add|list`.
 * Пресет = данные (connectors/<name>/): навык копируется в skills/,
 * broker-маршруты вставляются в envoy.yaml идемпотентно (маркер # connector:<name>).
 * Секретов в этой волне нет; команда только пишет файлы и печатает hints.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInstallPaths } from './fs.ts';

export interface BrokerRoute {
  readonly host: string;
  readonly cluster_address: string;
  readonly cluster_port: number;
  readonly tls: boolean;
}

/**
 * Sprint 24 (P-B): отдельный listener с собственным credential_injector —
 * у Envoy нет per-route секретов, поэтому OAuth-маршруты живут на своём порту.
 */
export interface BrokerListener {
  readonly port: number;
  readonly secret_name: string;
  readonly sds_path: string;
  readonly routes: readonly BrokerRoute[];
}

export interface ConnectorPreset {
  readonly name: string;
  readonly description: string;
  readonly skill: boolean;
  readonly broker_routes: readonly BrokerRoute[];
  readonly broker_listener?: BrokerListener;
  readonly config_hints: readonly string[];
  readonly dir: string;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VHOSTS_ANCHOR = /^(\s*)virtual_hosts:\s*$/m;
const CLUSTERS_ANCHOR = /^(\s*)clusters:\s*$/m;
const LISTENERS_ANCHOR = /^(\s*)listeners:\s*$/m;

export function marker(name: string): string {
  return `# connector:${name}`;
}

/** Маркер listener-блока: не участвует в парном инварианте vhost/cluster. */
export function listenerMarker(name: string): string {
  return `# connector:${name} listener`;
}

export function loadPreset(connectorsDir: string, name: string): ConnectorPreset {
  if (!NAME_RE.test(name)) throw new Error(`invalid connector name: ${name}`);
  const dir = join(connectorsDir, name);
  const metaPath = join(dir, 'connector.json');
  if (!existsSync(metaPath)) throw new Error(`unknown connector: ${name}`);
  const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  if (raw.schema_version !== 1) throw new Error(`connector ${name}: unsupported schema_version`);
  if (raw.name !== name) throw new Error(`connector ${name}: name mismatch in connector.json`);
  const routes = Array.isArray(raw.broker_routes) ? (raw.broker_routes as BrokerRoute[]) : [];
  for (const r of routes) {
    if (!r.host || !r.cluster_address || !Number.isInteger(r.cluster_port)) {
      throw new Error(`connector ${name}: malformed broker_route`);
    }
  }
  let listener: BrokerListener | undefined;
  if (raw.broker_listener !== undefined) {
    const l = raw.broker_listener as BrokerListener;
    if (
      !Number.isInteger(l.port) ||
      !l.secret_name ||
      !l.sds_path ||
      !Array.isArray(l.routes) ||
      l.routes.length === 0
    ) {
      throw new Error(`connector ${name}: malformed broker_listener`);
    }
    for (const r of l.routes) {
      if (!r.host || !r.cluster_address || !Number.isInteger(r.cluster_port)) {
        throw new Error(`connector ${name}: malformed broker_listener route`);
      }
    }
    listener = l;
  }
  return {
    name,
    description: String(raw.description ?? ''),
    skill: raw.skill === true,
    broker_routes: routes,
    ...(listener !== undefined ? { broker_listener: listener } : {}),
    config_hints: Array.isArray(raw.config_hints) ? (raw.config_hints as string[]) : [],
    dir,
  };
}

export function listPresets(connectorsDir: string): string[] {
  if (!existsSync(connectorsDir)) return [];
  return readdirSync(connectorsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(connectorsDir, e.name, 'connector.json')))
    .map((e) => e.name)
    .sort();
}

function pad(text: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l.length > 0 ? indent + l : l))
    .join('\n');
}

function vhostBlock(name: string, route: BrokerRoute, i: number): string {
  const cluster = `conn-${name}-${i}`;
  return [
    marker(name),
    `- name: ${cluster}`,
    `  domains: ['${route.host}', '${route.host}:*']`,
    `  routes:`,
    `    - match: { prefix: '/' }`,
    `      route:`,
    `        cluster: ${cluster}`,
    `        host_rewrite_literal: ${route.host}`,
  ].join('\n');
}

function clusterBlock(name: string, route: BrokerRoute, i: number): string {
  const cluster = `conn-${name}-${i}`;
  const tls = route.tls
    ? [
        `  transport_socket:`,
        `    name: envoy.transport_sockets.tls`,
        `    typed_config:`,
        `      '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext`,
        `      sni: ${route.host}`,
      ]
    : [];
  return [
    marker(name),
    `- name: ${cluster}`,
    `  type: STRICT_DNS`,
    ...tls,
    `  load_assignment:`,
    `    cluster_name: ${cluster}`,
    `    endpoints:`,
    `      - lb_endpoints:`,
    `          - endpoint:`,
    `              address:`,
    `                socket_address: { address: ${route.cluster_address}, port_value: ${route.cluster_port} }`,
  ].join('\n');
}

function listenerVhost(name: string, route: BrokerRoute, i: number): string[] {
  const cluster = `conn-${name}-${i}`;
  return [
    `                    - name: ${cluster}`,
    `                      domains: ['${route.host}', '${route.host}:*']`,
    `                      routes:`,
    `                        - match: { prefix: '/' }`,
    `                          route:`,
    `                            cluster: ${cluster}`,
    `                            host_rewrite_literal: ${route.host}`,
  ];
}

/**
 * Целый listener c собственным credential_injector: секрет из l.sds_path
 * инжектится ТОЛЬКО в маршруты этого порта (изоляция от broker_token :8080).
 */
function listenerBlock(name: string, l: BrokerListener, clusterOffset: number): string {
  const vhosts = l.routes.flatMap((r, i) => listenerVhost(name, r, clusterOffset + i));
  return [
    listenerMarker(name),
    `- name: conn-${name}-listener`,
    `  address:`,
    `    socket_address: { address: 0.0.0.0, port_value: ${l.port} }`,
    `  filter_chains:`,
    `    - filters:`,
    `        - name: envoy.filters.network.http_connection_manager`,
    `          typed_config:`,
    `            '@type': type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager`,
    `            stat_prefix: conn_${name.replaceAll('-', '_')}`,
    `            route_config:`,
    `              name: conn-${name}`,
    `              virtual_hosts:`,
    ...vhosts,
    `            http_filters:`,
    `              - name: envoy.filters.http.credential_injector`,
    `                typed_config:`,
    `                  '@type': type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector`,
    `                  allow_request_without_credential: false`,
    `                  credential:`,
    `                    name: envoy.http.injected_credentials.generic`,
    `                    typed_config:`,
    `                      '@type': type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic`,
    `                      header_value_prefix: 'Bearer '`,
    `                      credential:`,
    `                        name: ${l.secret_name}`,
    `                        sds_config:`,
    `                          path_config_source:`,
    `                            path: ${l.sds_path}`,
    `              - name: envoy.filters.http.router`,
    `                typed_config:`,
    `                  '@type': type.googleapis.com/envoy.extensions.filters.http.router.v3.Router`,
  ].join('\n');
}

function insertAfterAnchor(
  yaml: string,
  anchor: RegExp,
  block: string,
  childIndent: number,
): string {
  const m = anchor.exec(yaml);
  if (!m) throw new Error('envoy.yaml: anchor not found (unexpected template structure)');
  const baseIndent = m[1]!.length + childIndent;
  const insertAt = m.index + m[0].length;
  return `${yaml.slice(0, insertAt)}\n${pad(block, baseIndent)}${yaml.slice(insertAt)}`;
}

/** Идемпотентная вставка маршрутов пресета; повторный вызов — no-op. */
export function mergeEnvoy(
  yaml: string,
  preset: ConnectorPreset,
): { yaml: string; changed: boolean } {
  const listener = preset.broker_listener;
  if (preset.broker_routes.length === 0 && listener === undefined) {
    return { yaml, changed: false };
  }
  if (yaml.includes(marker(preset.name))) return { yaml, changed: false };
  let out = yaml;
  preset.broker_routes.forEach((route, i) => {
    out = insertAfterAnchor(out, VHOSTS_ANCHOR, vhostBlock(preset.name, route, i), 2);
    out = insertAfterAnchor(out, CLUSTERS_ANCHOR, clusterBlock(preset.name, route, i), 2);
  });
  if (listener !== undefined) {
    const offset = preset.broker_routes.length;
    out = insertAfterAnchor(out, LISTENERS_ANCHOR, listenerBlock(preset.name, listener, offset), 2);
    listener.routes.forEach((route, i) => {
      out = insertAfterAnchor(
        out,
        CLUSTERS_ANCHOR,
        clusterBlock(preset.name, route, offset + i),
        2,
      );
    });
  }
  return { yaml: out, changed: true };
}

export interface ApplyResult {
  readonly name: string;
  readonly skillInstalled: boolean;
  readonly routesAdded: number;
  readonly hints: readonly string[];
}

export function applyConnector(root: string, preset: ConnectorPreset): ApplyResult {
  const paths = resolveInstallPaths(root);
  let skillInstalled = false;

  if (preset.skill) {
    const target = join(root, 'skills', preset.name);
    const skillMd = readFileSync(join(preset.dir, 'SKILL.md'), 'utf8');
    const manifest = readFileSync(join(preset.dir, 'manifest.json'), 'utf8');
    if (!existsSync(join(target, 'SKILL.md'))) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'SKILL.md'), skillMd, 'utf8');
      writeFileSync(join(target, 'manifest.json'), manifest, 'utf8');
      skillInstalled = true;
    }
  }

  let routesAdded = 0;
  const totalRoutes = preset.broker_routes.length + (preset.broker_listener?.routes.length ?? 0);
  if (totalRoutes > 0 && existsSync(paths.brokerEnvoy)) {
    const before = readFileSync(paths.brokerEnvoy, 'utf8');
    const merged = mergeEnvoy(before, preset);
    if (merged.changed) {
      writeFileSync(paths.brokerEnvoy, merged.yaml, 'utf8');
      routesAdded = totalRoutes;
    }
  }

  return { name: preset.name, skillInstalled, routesAdded, hints: preset.config_hints };
}

/**
 * Sprint 23 DoD: verify ловит битый маршрут — каждый маркер должен встречаться
 * парой (virtual_host + cluster), а имена conn-* кластеров — совпадать.
 * Sprint 24: маркер `… listener` (целый listener-блок) в парном инварианте не
 * участвует — кластеры такого пресета по-прежнему считаются парами не с vhost,
 * а между собой (чётность), ссылки cluster/cluster_name проверяются ниже.
 */
export function checkEnvoyRoutes(yaml: string): { ok: boolean; detail: string } {
  const matches = [...yaml.matchAll(/# connector:([a-z0-9-]+)( listener)?/g)];
  const names = new Set(matches.map((m) => m[1] ?? ''));
  const broken: string[] = [];
  for (const name of names) {
    const paired = matches.filter((m) => m[1] === name && m[2] === undefined).length;
    if (paired % 2 !== 0) broken.push(`${name}: unpaired marker (vhost/cluster mismatch)`);
  }
  const referenced = [...yaml.matchAll(/(?<!_)cluster: (conn-[a-z0-9-]+)/g)].map((m) => m[1]!);
  const defined = new Set([...yaml.matchAll(/cluster_name: (conn-[a-z0-9-]+)/g)].map((m) => m[1]!));
  for (const c of referenced) {
    if (!defined.has(c)) broken.push(`route references missing cluster ${c}`);
  }
  if (broken.length > 0) return { ok: false, detail: broken.join('; ') };
  return {
    ok: true,
    detail: names.size > 0 ? `${names.size} connector route(s) ok` : 'no connector routes',
  };
}

export function connectorStatus(root: string, name: string): 'installed' | 'available' {
  const paths = resolveInstallPaths(root);
  const skillInstalled = existsSync(join(root, 'skills', name, 'manifest.json'));
  const envoy = existsSync(paths.brokerEnvoy) ? readFileSync(paths.brokerEnvoy, 'utf8') : '';
  return skillInstalled || envoy.includes(marker(name)) ? 'installed' : 'available';
}

export function runConnector(root: string, args: readonly string[]): number {
  const connectorsDir = join(root, 'connectors');
  const [sub, ...names] = args;

  if (sub === 'list' || sub === undefined) {
    const presets = listPresets(connectorsDir);
    if (presets.length === 0) {
      console.log('No connector presets found (expected connectors/<name>/connector.json).');
      return 0;
    }
    for (const n of presets) {
      const p = loadPreset(connectorsDir, n);
      console.log(
        `${connectorStatus(root, n) === 'installed' ? '[x]' : '[ ]'} ${n} — ${p.description}`,
      );
    }
    return 0;
  }

  if (sub !== 'add' || names.length === 0) {
    console.error('Usage: aegis-setup connector [list | add <name…>]');
    return 1;
  }

  for (const name of names) {
    let result: ApplyResult;
    try {
      result = applyConnector(root, loadPreset(connectorsDir, name));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    console.log(
      `${name}: skill ${result.skillInstalled ? 'installed' : 'already present/none'}, broker routes ${
        result.routesAdded > 0 ? `added (${result.routesAdded})` : 'unchanged'
      }`,
    );
    for (const h of result.hints) console.log(`  hint: ${h}`);
  }
  console.log('\nNext: review deploy/broker/envoy.yaml, then restart the broker container.');
  return 0;
}
