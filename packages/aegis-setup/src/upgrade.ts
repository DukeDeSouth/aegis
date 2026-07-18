import { existsSync } from 'node:fs';
import { generateConfig, generateDockerCompose, generateHostEnv, SETUP_VERSION, type SetupInput } from './templates.ts';
import { readManifest, readText, resolveInstallPaths, writePlans } from './fs.ts';
import { createPrompter } from './prompt.ts';

function jsonKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    keys.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...jsonKeys(v, p));
  }
  return keys;
}

function diffLines(oldText: string, newText: string): string[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i] ?? '';
    const n = newLines[i] ?? '';
    if (o !== n) out.push(`@@ line ${i + 1}`);
    if (o !== n && o.length > 0) out.push(`- ${o}`);
    if (o !== n && n.length > 0) out.push(`+ ${n}`);
  }
  return out;
}

export interface UpgradeOptions {
  readonly root: string;
  readonly force: boolean;
}

export async function runUpgrade(opts: UpgradeOptions): Promise<number> {
  const paths = resolveInstallPaths(opts.root);
  if (!existsSync(paths.config)) {
    console.error('No installation found. Run aegis-setup init first.');
    return 1;
  }

  let existing: SetupInput;
  try {
    const raw = JSON.parse(readText(paths.config) ?? '{}') as Record<string, unknown>;
    const llm = raw.llm as { p_llm?: { base_url?: string; model?: string }; q_llm?: { base_url?: string; model?: string } };
    existing = {
      dataDir: String(raw.data_dir ?? './data'),
      llmBaseUrl: llm?.p_llm?.base_url ?? 'http://localhost:11434/v1',
      llmModel: llm?.p_llm?.model ?? 'qwen3:14b',
      qLlmBaseUrl: llm?.q_llm?.base_url ?? 'http://localhost:11434/v1',
      qLlmModel: llm?.q_llm?.model ?? 'qwen3:14b',
      pairingCode: 'unchanged',
    };
  } catch {
    console.error('Invalid aegis.config.json');
    return 1;
  }

  const newConfig = generateConfig(existing);
  const manifest = readManifest(opts.root);
  const brokerMode = manifest.broker_mode ?? 'local';
  const newCompose = generateDockerCompose(brokerMode);
  const oldConfig = readText(paths.config) ?? '';
  const oldCompose = readText(paths.compose) ?? '';

  console.log(`Setup template version: ${SETUP_VERSION}\n`);
  console.log('--- aegis.config.json (structure keys) ---');
  const oldKeys = new Set(jsonKeys(JSON.parse(oldConfig || '{}')));
  const newKeys = new Set(jsonKeys(JSON.parse(newConfig)));
  for (const k of newKeys) {
    if (!oldKeys.has(k)) console.log(`+ key: ${k}`);
  }
  for (const k of oldKeys) {
    if (!newKeys.has(k)) console.log(`- key: ${k}`);
  }

  console.log('\n--- deploy/docker-compose.yml diff (excerpt) ---');
  const composeDiff = diffLines(oldCompose, newCompose).slice(0, 40);
  console.log(composeDiff.length > 0 ? composeDiff.join('\n') : '(no line changes)');

  if (!opts.force) {
    const p = createPrompter();
    const ok = await p.confirm('Apply compose template upgrade? (config keys listed only, config body not auto-merged)', false);
    p.close();
    if (!ok) {
      console.log('Aborted.');
      return 0;
    }
  }

  writePlans([{ path: paths.compose, content: newCompose }], false);
  console.log('Updated deploy/docker-compose.yml. Review aegis.config.json manually for new keys.');
  return 0;
}
