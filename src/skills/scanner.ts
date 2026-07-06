/**
 * Статический сканер скриптов навыка (MVP denylist, SKILLS_MODEL).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DENY_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'curl_pipe_shell', re: /curl\s+[^\n|]*\|\s*(ba)?sh\b/ },
  { id: 'wget_pipe_shell', re: /wget\s+[^\n|]*\|\s*(ba)?sh\b/ },
  { id: 'pipe_bash', re: /\|\s*bash\b/ },
  { id: 'pipe_sh', re: /\|\s*sh\b/ },
  { id: 'eval', re: /\beval\s*\(/ },
  { id: 'child_process', re: /child_process/ },
  { id: 'exec_sync', re: /execSync/ },
  { id: 'npm_install', re: /\bnpm\s+install\b/ },
  { id: 'pip_install', re: /\bpip\s+install\b/ },
];

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.py']);

export interface ScanHit {
  file: string;
  patternId: string;
}

export function scanSkillDir(skillDir: string): ScanHit[] {
  const scriptsDir = join(skillDir, 'scripts');
  if (!statSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }
  if (!statSync(scriptsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }
  const hits: ScanHit[] = [];
  for (const name of readdirSync(scriptsDir)) {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const rel = join('scripts', name);
    const content = readFileSync(join(skillDir, rel), 'utf8');
    for (const { id, re } of DENY_PATTERNS) {
      if (re.test(content)) {
        hits.push({ file: rel, patternId: id });
      }
    }
  }
  return hits;
}

export function scanRejects(skillDir: string): string | undefined {
  const hits = scanSkillDir(skillDir);
  if (hits.length === 0) return undefined;
  return hits.map((h) => `${h.file}: ${h.patternId}`).join('; ');
}
