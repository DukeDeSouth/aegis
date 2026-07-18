import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateBrokerCerts, renderBrokerClientEnvoy } from './certs.ts';
import {
  generateComposeEnv,
  generateConfig,
  generateDockerCompose,
  generateHostEnv,
  generatePairingCode,
  setupManifest,
  type BrokerMode,
  type SetupInput,
} from './templates.ts';
import { planSummary, readBundledBrokerFile, resolveInstallPaths, writePlans, type WritePlan } from './fs.ts';
import { createPrompter } from './prompt.ts';

export interface InitOptions {
  readonly targetDir: string;
  readonly force: boolean;
  readonly nonInteractive?: boolean;
  readonly brokerMode?: BrokerMode;
  readonly brokerHost?: string;
  readonly answers?: Partial<{
    llmBaseUrl: string;
    llmModel: string;
    qLlmBaseUrl: string;
    qLlmModel: string;
    dataDir: string;
    brokerApiKey: string;
    tgToken: string;
  }>;
}

export function buildPlans(
  root: string,
  input: SetupInput,
  brokerKey?: string,
): WritePlan[] {
  const paths = resolveInstallPaths(root);
  const brokerMode = input.brokerMode ?? 'local';
  const brokerSecretAbs = paths.brokerToken;
  const plans: WritePlan[] = [
    { path: paths.config, content: generateConfig(input) },
    { path: paths.hostEnv, content: generateHostEnv(input.pairingCode) },
    {
      path: paths.composeEnv,
      content: generateComposeEnv(brokerSecretAbs, {
        brokerMode,
        ...(input.brokerRemoteHost !== undefined
          ? { brokerRemoteHost: input.brokerRemoteHost }
          : {}),
      }),
    },
    { path: paths.compose, content: generateDockerCompose(brokerMode) },
    {
      path: paths.manifest,
      content: setupManifest({
        brokerMode,
        ...(input.brokerRemoteHost !== undefined
          ? { brokerRemoteHost: input.brokerRemoteHost }
          : {}),
      }),
    },
  ];

  if (brokerMode === 'local' && brokerKey !== undefined && brokerKey.length > 0) {
    plans.push({ path: paths.brokerToken, content: brokerKey, mode: 0o600 });
  }
  if (brokerMode === 'remote' && brokerKey !== undefined && brokerKey.length > 0) {
    plans.push({ path: paths.brokerRemoteToken, content: brokerKey, mode: 0o600 });
  }

  return plans;
}

function copyBundledRemoteBroker(paths: ReturnType<typeof resolveInstallPaths>): WritePlan[] {
  const plans: WritePlan[] = [];
  const remoteDir = join(paths.root, 'deploy', 'broker-remote');
  for (const name of ['envoy.yaml', 'secret.yaml', 'docker-compose.yml', 'README.md', '.env.example'] as const) {
    const content = readBundledBrokerFile(`remote/${name}`);
    if (content !== undefined) {
      plans.push({ path: join(remoteDir, name), content });
    }
  }
  return plans;
}

export async function runInit(opts: InitOptions): Promise<number> {
  const paths = resolveInstallPaths(opts.targetDir);
  if (existsSync(paths.config) && !opts.force) {
    console.error('aegis.config.json already exists. Use --force to overwrite.');
    return 1;
  }

  let brokerMode: BrokerMode = opts.brokerMode ?? 'local';
  let brokerRemoteHost = opts.brokerHost ?? '';

  let llmBaseUrl = opts.answers?.llmBaseUrl ?? 'http://localhost:11434/v1';
  let llmModel = opts.answers?.llmModel ?? 'qwen3:14b';
  let qLlmBaseUrl = opts.answers?.qLlmBaseUrl ?? llmBaseUrl;
  let qLlmModel = opts.answers?.qLlmModel ?? llmModel;
  let dataDir = opts.answers?.dataDir ?? './data';
  let brokerKey = opts.answers?.brokerApiKey ?? '';
  let tgToken = opts.answers?.tgToken ?? '';

  if (!opts.nonInteractive) {
    const p = createPrompter();
    console.log('AEGIS setup — generates config and deploy files (no curl|bash).\n');
    const remote = await p.confirm('Remote credential broker on separate host (mTLS)?', false);
    brokerMode = remote ? 'remote' : 'local';
    if (brokerMode === 'remote') {
      brokerRemoteHost = await p.ask('Broker host (FQDN or IP)', brokerRemoteHost || '10.0.0.2');
    }
    llmBaseUrl = await p.ask('P-LLM base URL', llmBaseUrl);
    llmModel = await p.ask('P-LLM model', llmModel);
    const sameQ = await p.confirm('Use same URL/model for Q-LLM (quarantine)?', true);
    if (sameQ) {
      qLlmBaseUrl = llmBaseUrl;
      qLlmModel = llmModel;
    } else {
      qLlmBaseUrl = await p.ask('Q-LLM base URL', llmBaseUrl);
      qLlmModel = await p.ask('Q-LLM model', llmModel);
    }
    dataDir = await p.ask('Data directory', dataDir);
    tgToken = await p.ask('Telegram bot token (paste now, stored in .env only)');
    brokerKey = await p.ask('Broker API key (optional, for web-fetch skills)');
    p.close();
  }

  if (brokerMode === 'remote' && brokerRemoteHost.trim().length === 0) {
    console.error('Remote broker mode requires --broker-host <fqdn|ip>');
    return 1;
  }

  const pairingCode = generatePairingCode();
  const input: SetupInput = {
    dataDir,
    llmBaseUrl,
    llmModel,
    qLlmBaseUrl,
    qLlmModel,
    pairingCode,
    brokerMode,
    brokerRemoteHost: brokerRemoteHost.trim(),
  };

  const plans = buildPlans(opts.targetDir, input, brokerKey);

  if (brokerMode === 'remote') {
    generateBrokerCerts(opts.targetDir, brokerRemoteHost.trim());
    plans.push({
      path: paths.brokerClientEnvoy,
      content: renderBrokerClientEnvoy(brokerRemoteHost.trim()),
    });
    plans.push(...copyBundledRemoteBroker(paths));
    plans.push({
      path: join(paths.root, 'deploy', 'broker', 'REMOTE_MODE.md'),
      content: `# Local broker disabled\n\nBroker secrets live on the remote host. See deploy/broker-remote/README.md.\n`,
    });
  }

  console.log('Files to write:\n' + planSummary(plans));
  console.log(`\nPairing code: ${pairingCode}`);
  console.log('WebChat: http://127.0.0.1:8790 — enter pairing code in browser');
  console.log('Telegram (optional): after start, send to bot: /pair ' + pairingCode);
  console.log(
    'Matrix (optional): set AEGIS_MATRIX_HOMESERVER + AEGIS_MATRIX_ACCESS_TOKEN in .env.aegis,',
  );
  console.log('  add "matrix": {} to aegis.config.json, DM bot: /pair ' + pairingCode);
  console.log(
    'Slack (optional): api.slack.com app + Socket Mode; set AEGIS_SLACK_BOT_TOKEN + AEGIS_SLACK_APP_TOKEN,',
  );
  console.log('  add "slack": {} to aegis.config.json, DM bot: /pair ' + pairingCode);

  if (!opts.nonInteractive) {
    const p = createPrompter();
    const ok = await p.confirm('Write files?', true);
    p.close();
    if (!ok) {
      console.log('Aborted.');
      return 0;
    }
  }

  writePlans(plans, false);
  if (brokerMode === 'local') {
    writeBrokerTemplates(paths);
  } else {
    writeBrokerTemplates(paths);
    console.log('\nRemote broker: rsync deploy/broker-remote/ to broker VPS, then docker compose up -d');
  }

  if (tgToken.length > 0) {
    const hostEnv = generateHostEnv(pairingCode).replace(
      'AEGIS_TG_BOT_TOKEN=',
      `AEGIS_TG_BOT_TOKEN=${tgToken}`,
    );
    writePlans([{ path: paths.hostEnv, content: hostEnv }], false);
    const composeBody = generateComposeEnv(paths.brokerToken, {
      brokerMode,
      brokerRemoteHost: brokerRemoteHost.trim(),
    })
      .replace('AEGIS_TG_BOT_TOKEN=', `AEGIS_TG_BOT_TOKEN=${tgToken}`)
      .replace('AEGIS_TG_PAIRING_CODE=', `AEGIS_TG_PAIRING_CODE=${pairingCode}`);
    writePlans([{ path: paths.composeEnv, content: composeBody }], false);
  }

  console.log('\nNext steps:');
  console.log(`  1. Edit ${paths.hostEnv} — add LLM keys if needed`);
  console.log(
    '     Tip: set learning.self_improvement_llm_enabled=true in aegis.config.json for F5 self-improvement',
  );
  if (brokerMode === 'remote') {
    console.log('  2. rsync deploy/broker-remote/ to broker host; docker compose up -d');
    console.log(
      `  3. cd ${join(opts.targetDir, 'deploy')} && docker compose --env-file .env --profile remote-broker up -d broker-client`,
    );
  } else {
    console.log(`  2. cd ${join(opts.targetDir, 'deploy')} && docker compose --env-file .env up -d broker`);
  }
  console.log('  3. source .env.aegis && npm start');
  console.log('  4. aegis-setup verify');
  return 0;
}

function writeBrokerTemplates(paths: ReturnType<typeof resolveInstallPaths>): void {
  if (existsSync(paths.brokerEnvoy)) return;
  const plans: WritePlan[] = [];
  for (const name of ['envoy.yaml', 'secret.yaml'] as const) {
    const content = readBundledBrokerFile(name);
    if (content !== undefined) {
      plans.push({ path: join(paths.root, 'deploy', 'broker', name), content });
    }
  }
  if (plans.length > 0) writePlans(plans, false);
}
