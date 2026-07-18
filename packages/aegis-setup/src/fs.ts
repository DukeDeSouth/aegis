import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WritePlan {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

export function planSummary(plans: readonly WritePlan[]): string {
  return plans.map((p) => `  - ${p.path}${p.mode === 0o600 ? ' (mode 600)' : ''}`).join('\n');
}

export function writePlans(plans: readonly WritePlan[], dryRun: boolean): void {
  for (const p of plans) {
    if (dryRun) continue;
    mkdirSync(dirname(p.path), { recursive: true });
    writeFileSync(p.path, p.content, 'utf8');
    if (p.mode !== undefined) chmodSync(p.path, p.mode);
  }
}

export function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

export function resolveInstallPaths(root: string) {
  const deploy = join(root, 'deploy');
  return {
    root,
    config: join(root, 'aegis.config.json'),
    hostEnv: join(root, '.env.aegis'),
    compose: join(deploy, 'docker-compose.yml'),
    composeEnv: join(deploy, '.env'),
    brokerToken: join(deploy, 'broker', 'token.txt'),
    brokerRemoteToken: join(deploy, 'broker-remote', 'secrets', 'token.txt'),
    manifest: join(root, '.aegis-setup.json'),
    brokerEnvoy: join(deploy, 'broker', 'envoy.yaml'),
    brokerRemoteEnvoy: join(deploy, 'broker-remote', 'envoy.yaml'),
    brokerClientEnvoy: join(deploy, 'broker-client', 'envoy.yaml'),
    brokerSecretYaml: join(deploy, 'broker', 'secret.yaml'),
    brokerRemoteSecretYaml: join(deploy, 'broker-remote', 'secret.yaml'),
  };
}

export interface SetupManifest {
  readonly setup_version?: number;
  readonly broker_mode?: 'local' | 'remote';
  readonly broker_remote_host?: string;
}

export function readManifest(root: string): SetupManifest {
  const text = readText(resolveInstallPaths(root).manifest);
  if (text === undefined) return {};
  return JSON.parse(text) as SetupManifest;
}

/** Envoy file that receives connector routes (local vs remote broker host). */
export function resolveBrokerEnvoyPath(root: string): string {
  const paths = resolveInstallPaths(root);
  if (readManifest(root).broker_mode === 'remote') return paths.brokerRemoteEnvoy;
  return paths.brokerEnvoy;
}

export function bundledBrokerDir(): string {
  return join(fileURLToPath(new URL('../templates/broker', import.meta.url)));
}

export function readBundledBrokerFile(name: string): string | undefined {
  const p = join(bundledBrokerDir(), name);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8');
}
