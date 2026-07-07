import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePairingCode, generateConfig, generateComposeEnv, generateDockerCompose, generateHostEnv, setupManifest, type SetupInput } from './templates.ts';
import { planSummary, readBundledBrokerFile, resolveInstallPaths, writePlans, type WritePlan } from './fs.ts';
import { createPrompter } from './prompt.ts';

export interface InitOptions {
  readonly targetDir: string;
  readonly force: boolean;
  readonly nonInteractive?: boolean;
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

export function buildPlans(root: string, input: SetupInput, brokerKey?: string): WritePlan[] {
  const paths = resolveInstallPaths(root);
  const brokerSecretAbs = paths.brokerToken;
  const plans: WritePlan[] = [
    { path: paths.config, content: generateConfig(input) },
    { path: paths.hostEnv, content: generateHostEnv(input.pairingCode) },
    { path: paths.composeEnv, content: generateComposeEnv(brokerSecretAbs) },
    { path: paths.compose, content: generateDockerCompose() },
    { path: paths.manifest, content: setupManifest() },
  ];
  if (brokerKey !== undefined && brokerKey.length > 0) {
    plans.push({ path: paths.brokerToken, content: brokerKey, mode: 0o600 });
  }
  return plans;
}

export async function runInit(opts: InitOptions): Promise<number> {
  const paths = resolveInstallPaths(opts.targetDir);
  if (existsSync(paths.config) && !opts.force) {
    console.error('aegis.config.json already exists. Use --force to overwrite.');
    return 1;
  }

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

  const pairingCode = generatePairingCode();
  const input: SetupInput = {
    dataDir,
    llmBaseUrl,
    llmModel,
    qLlmBaseUrl,
    qLlmModel,
    pairingCode,
  };

  const plans = buildPlans(opts.targetDir, input, brokerKey);
  console.log('Files to write:\n' + planSummary(plans));
  console.log(`\nPairing code: ${pairingCode}`);
  console.log('After start, send to bot: /pair ' + pairingCode);

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
  writeBrokerTemplates(paths);

  if (tgToken.length > 0) {
    const hostEnv = generateHostEnv(pairingCode).replace(
      'AEGIS_TG_BOT_TOKEN=',
      `AEGIS_TG_BOT_TOKEN=${tgToken}`,
    );
    writePlans([{ path: paths.hostEnv, content: hostEnv }], false);
    const composeEnvPath = paths.composeEnv;
    const composeBody = generateComposeEnv(paths.brokerToken)
      .replace('AEGIS_TG_BOT_TOKEN=', `AEGIS_TG_BOT_TOKEN=${tgToken}`)
      .replace('AEGIS_TG_PAIRING_CODE=', `AEGIS_TG_PAIRING_CODE=${pairingCode}`);
    writePlans([{ path: composeEnvPath, content: composeBody }], false);
  }

  console.log('\nNext steps:');
  console.log(`  1. Edit ${paths.hostEnv} — add LLM keys if needed`);
  console.log(`  2. cd ${join(opts.targetDir, 'deploy')} && docker compose --env-file .env up -d broker`);
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
