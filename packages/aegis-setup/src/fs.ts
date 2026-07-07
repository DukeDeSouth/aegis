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
    manifest: join(root, '.aegis-setup.json'),
    brokerEnvoy: join(deploy, 'broker', 'envoy.yaml'),
    brokerSecretYaml: join(deploy, 'broker', 'secret.yaml'),
  };
}

export function bundledBrokerDir(): string {
  return join(fileURLToPath(new URL('../templates/broker', import.meta.url)));
}

export function readBundledBrokerFile(name: string): string | undefined {
  const p = join(bundledBrokerDir(), name);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8');
}
