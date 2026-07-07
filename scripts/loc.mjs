// Контроль размера доверенного ядра (docs/REPO_LAYOUT.md):
// непустые строки .ts в src/; порог 4000 — предупреждение, не хард-блок.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 7500; // ADR-0009: post-MVP F8 MCP sandbox

function countDir(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += countDir(p);
    else if (entry.name.endsWith('.ts'))
      total += readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '').length;
  }
  return total;
}

const loc = countDir('src');
console.log(`src/ LOC (non-empty .ts lines): ${loc} / ${LIMIT}`);
if (loc > LIMIT) console.warn(`WARNING: core exceeds ${LIMIT} LOC — review required (MVP_SCOPE)`);
