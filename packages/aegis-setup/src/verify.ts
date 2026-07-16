import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkBrokerRunning,
  checkBrokerSmoke,
  checkDocker,
  checkNodeVersion,
  checkTelegramToken,
  parseEnvFile,
  type ExecFn,
} from './checks.ts';
import { checkEnvoyRoutes } from './connector.ts';
import { readText, resolveInstallPaths } from './fs.ts';

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

  const composeOk = existsSync(paths.compose);
  results.push({
    name: 'compose',
    ok: composeOk,
    detail: composeOk ? paths.compose : `missing ${paths.compose}`,
  });

  const brokerYaml = existsSync(paths.brokerEnvoy);
  results.push({
    name: 'broker-config',
    ok: brokerYaml,
    detail: brokerYaml ? 'envoy.yaml present' : 'missing deploy/broker/envoy.yaml',
  });

  if (brokerYaml) {
    const routes = checkEnvoyRoutes(readText(paths.brokerEnvoy) ?? '');
    results.push({ name: 'connector-routes', ok: routes.ok, detail: routes.detail });
  }

  if (composeOk) {
    const broker = await checkBrokerRunning(join(paths.root, 'deploy'), exec);
    if ('skipped' in broker && broker.skipped) {
      results.push({ name: 'broker', ok: true, detail: 'skipped (compose not running)' });
    } else {
      results.push({
        name: 'broker',
        ok: broker.ok,
        detail: broker.ok ? 'broker running' : broker.reason,
      });
      if (broker.ok && brokerYaml) {
        const smoke = await checkBrokerSmoke(
          join(paths.root, 'deploy'),
          readText(paths.brokerEnvoy) ?? '',
          exec,
        );
        if ('skipped' in smoke && smoke.skipped) {
          results.push({ name: 'broker-smoke', ok: true, detail: 'skipped' });
        } else {
          results.push({
            name: 'broker-smoke',
            ok: smoke.ok,
            detail: 'ok' in smoke && smoke.ok ? smoke.detail : (smoke as { reason: string }).reason,
          });
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
