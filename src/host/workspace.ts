/**
 * Workspace: изолированная директория для file.read / file.write (Sprint 14 / F4).
 * Путь нормализуется и проверяется в ядре до любого I/O (TOCTOU-защита через realpath).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';

const TRASH = '.aegis-trash';

export function resolveWorkspacePath(rootDir: string, userPath: string): string {
  const rel = normalize(userPath.trim());
  if (
    !rel ||
    rel === '.' ||
    rel.startsWith(sep) ||
    rel.split(sep).some((p) => p === '..') ||
    rel === TRASH ||
    rel.startsWith(`${TRASH}${sep}`)
  ) {
    throw new Error('forbidden path');
  }
  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });
  const candidate = resolve(root, rel);
  const rootReal = realpathSync(root);
  let targetReal: string;
  try {
    targetReal = realpathSync(candidate);
  } catch {
    const parent = dirname(candidate);
    mkdirSync(parent, { recursive: true });
    targetReal = resolve(realpathSync(parent), basename(candidate));
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    throw new Error('path escapes workspace');
  }
  return candidate;
}

export class WorkspaceStore {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(rootDir: string, opts: { now?: () => number } = {}) {
    this.rootDir = rootDir;
    this.now = opts.now ?? Date.now;
  }

  private trashBatch(ts: number): string {
    return join(resolve(this.rootDir), TRASH, String(ts));
  }

  read(relPath: string): string {
    return readFileSync(resolveWorkspacePath(this.rootDir, relPath), 'utf8');
  }

  write(relPath: string, content: string): void {
    const target = resolveWorkspacePath(this.rootDir, relPath);
    if (existsSync(target)) {
      const backup = join(this.trashBatch(this.now()), relPath);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(target, backup);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  undo(relPath: string): boolean {
    const target = resolveWorkspacePath(this.rootDir, relPath);
    const trashRoot = join(resolve(this.rootDir), TRASH);
    if (!existsSync(trashRoot)) return false;
    const batches = readdirSync(trashRoot)
      .map(Number)
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => b - a);
    for (const ts of batches) {
      const backup = join(trashRoot, String(ts), relPath);
      if (existsSync(backup)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(backup, target);
        return true;
      }
    }
    return false;
  }

  delete(relPath: string): boolean {
    const target = resolveWorkspacePath(this.rootDir, relPath);
    if (!existsSync(target)) return false;
    const dest = join(this.trashBatch(this.now()), relPath);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(target, dest);
    return true;
  }
}
