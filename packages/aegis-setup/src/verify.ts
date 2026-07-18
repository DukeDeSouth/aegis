import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkBrokerClientRunning,
  checkBrokerClientSmoke,
  checkBrokerRunning,
  checkBrokerSmoke,
  checkDocker,
  checkGvisorAvailable,
  checkNodeVersion,
  checkTelegramToken,
  parseEnvFile,
  type ExecFn,
} from './checks.ts';
import { checkEnvoyRoutes } from './connector.ts';
import { readManifest, readText, resolveInstallPaths } from './fs.ts';

export interface VerifyOptions {
  readonly root: string;
  readonly exec?: ExecFn;
  readonly fetchFn?: typeof fetch;
}

export interface VerifyResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export async function runVerify(opts: VerifyOptions): Promise<number> {
  const paths = resolveInstallPaths(opts.root);
  const manifest = readManifest(opts.root);
  const remoteBroker = manifest.broker_mode === 'remote';
  const exec = opts.exec;
  const results: VerifyResult[] = [];

  const node = await checkNodeVersion();
  results.push({ name: 'node', ok: node.ok, detail: node.ok ? process.version : node.reason });

  const docker = await checkDocker(exec);
  results.push({ name: 'docker', ok: docker.ok, detail: docker.ok ? 'daemon ok' : docker.reason });

  const configOk = existsSync(paths.config);
  results.push({
    name: 'config',
    ok: configOk,
    detail: configOk ? paths.config : `missing ${paths.config} — run aegis-setup init`,
  });

  let sandboxRuntime: 'docker' | 'gvisor' = 'docker';
  if (configOk) {
    try {
      const raw = JSON.parse(readText(paths.config) ?? '{}') as { sandbox?: { runtime?: string } };
      if (raw.sandbox?.runtime === 'gvisor') sandboxRuntime = 'gvisor';
    } catch {
      /* schema validated at host start; verify only gates gvisor smoke */
    }
  }
  if (sandboxRuntime === 'gvisor') {
    const gv = await checkGvisorAvailable(exec);
    results.push({
      name: 'gvisor',
      ok: gv.ok,
      detail: gv.ok ? 'runsc smoke ok' : gv.reason,
    });
  }

  const composeOk = existsSync(paths.compose);
  results.push({
    name: 'compose',
    ok: composeOk,
    detail: composeOk ? paths.compose : `missing ${paths.compose}`,
  });

  const envoyPath = remoteBroker ? paths.brokerRemoteEnvoy : paths.brokerEnvoy;
  const brokerYaml = existsSync(envoyPath);
  results.push({
    name: 'broker-config',
    ok: brokerYaml,
    detail: brokerYaml
      ? remoteBroker
        ? 'broker-remote envoy.yaml present'
        : 'envoy.yaml present'
      : remoteBroker
        ? 'missing deploy/broker-remote/envoy.yaml'
        : 'missing deploy/broker/envoy.yaml',
  });

  if (remoteBroker) {
    const clientYaml = existsSync(paths.brokerClientEnvoy);
    results.push({
      name: 'broker-client-config',
      ok: clientYaml,
      detail: clientYaml ? 'broker-client envoy.yaml present' : 'missing deploy/broker-client/envoy.yaml',
    });
    const host = manifest.broker_remote_host ?? '';
    results.push({
      name: 'broker-remote-host',
      ok: host.length > 0,
      detail: host.length > 0 ? host : 'broker_remote_host missing in .aegis-setup.json',
    });
  }

  if (brokerYaml) {
    const routes = checkEnvoyRoutes(readText(envoyPath) ?? '');
    results.push({ name: 'connector-routes', ok: routes.ok, detail: routes.detail });
  }

  if (composeOk) {
    const composeDir = join(paths.root, 'deploy');
    if (remoteBroker) {
      const client = await checkBrokerClientRunning(composeDir, exec);
      if ('skipped' in client && client.skipped) {
        results.push({ name: 'broker-client', ok: true, detail: 'skipped (compose not running)' });
      } else {
        results.push({
          name: 'broker-client',
          ok: client.ok,
          detail: client.ok ? 'broker-client running' : client.reason,
        });
        if (client.ok) {
          const smoke = await checkBrokerClientSmoke(composeDir, exec);
          if ('skipped' in smoke && smoke.skipped) {
            results.push({ name: 'broker-remote-smoke', ok: true, detail: 'skipped' });
          } else if (smoke.ok && 'detail' in smoke) {
            results.push({
              name: 'broker-remote-smoke',
              ok: true,
              detail: smoke.detail,
            });
          } else if (!smoke.ok && 'reason' in smoke) {
            results.push({
              name: 'broker-remote-smoke',
              ok: false,
              detail: smoke.reason,
            });
          } else {
            results.push({ name: 'broker-remote-smoke', ok: true, detail: 'skipped' });
          }
        }
      }
    } else {
      const broker = await checkBrokerRunning(composeDir, exec);
      if ('skipped' in broker && broker.skipped) {
        results.push({ name: 'broker', ok: true, detail: 'skipped (compose not running)' });
      } else {
        results.push({
          name: 'broker',
          ok: broker.ok,
          detail: broker.ok ? 'broker running' : broker.reason,
        });
        if (broker.ok && brokerYaml) {
          const smoke = await checkBrokerSmoke(composeDir, readText(envoyPath) ?? '', exec);
          if ('skipped' in smoke && smoke.skipped) {
            results.push({ name: 'broker-smoke', ok: true, detail: 'skipped' });
          } else if (smoke.ok && 'detail' in smoke) {
            results.push({
              name: 'broker-smoke',
              ok: true,
              detail: smoke.detail,
            });
          } else if (!smoke.ok && 'reason' in smoke) {
            results.push({
              name: 'broker-smoke',
              ok: false,
              detail: smoke.reason,
            });
          } else {
            results.push({ name: 'broker-smoke', ok: true, detail: 'skipped' });
          }
        }
      }
    }
  }

  const hostEnv = readText(paths.hostEnv);
  let tgToken = process.env.AEGIS_TG_BOT_TOKEN ?? '';
  if (hostEnv) tgToken = parseEnvFile(hostEnv).AEGIS_TG_BOT_TOKEN ?? tgToken;
  if (tgToken.length > 0) {
    const tg = await checkTelegramToken(tgToken, opts.fetchFn);
    results.push({
      name: 'telegram',
      ok: tg.ok,
      detail: tg.ok ? 'getMe ok' : tg.reason,
    });
  } else {
    results.push({
      name: 'telegram',
      ok: false,
      detail: 'AEGIS_TG_BOT_TOKEN not set in .env.aegis',
    });
  }

  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? 'OK' : 'FAIL';
    console.log(`[${mark}] ${r.name}: ${r.detail}`);
    if (!r.ok) failed++;
  }

  if (failed === 0) {
    console.log('\nAll checks passed.');
    return 0;
  }
  console.log(`\n${failed} check(s) failed.`);
  return 1;
}
