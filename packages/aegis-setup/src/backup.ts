/**
 * S4 (Sprint 35): full-install backup / restore (queue, memory, audit, workspace, skills).
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { resolveInstallPaths } from './fs.ts';

export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupManifest {
  schema_version: number;
  created_at: string;
  aegis_version: string;
  files: { path: string; sha256: string; bytes: number }[];
}

interface InstallLayout {
  root: string;
  configPath: string;
  dataDir: string;
  skillsDir: string;
  workspaceDir: string;
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const data = readFileSync(path);
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

function resolvePath(root: string, p: string): string {
  return p.startsWith('/') ? p : join(root, p);
}

function readInstallLayout(root: string, configPath?: string): InstallLayout {
  const paths = resolveInstallPaths(root);
  const cfgFile = configPath ?? paths.config;
  const raw = JSON.parse(readFileSync(cfgFile, 'utf8')) as {
    data_dir?: string;
    skills_dir?: string;
    sandbox?: { workspace_dir?: string };
  };
  const dataDir = resolvePath(root, raw.data_dir ?? './data');
  const skillsDir = resolvePath(root, raw.skills_dir ?? './skills');
  const workspaceDir = raw.sandbox?.workspace_dir
    ? resolvePath(root, raw.sandbox.workspace_dir)
    : join(dataDir, 'workspace');
  return {
    root,
    configPath: configPath ? join(root, 'aegis.config.json') : paths.config,
    dataDir,
    skillsDir,
    workspaceDir,
  };
}

function vacuumDbSnapshot(srcPath: string, destPath: string): void {
  if (!existsSync(srcPath)) return;
  mkdirSync(join(destPath, '..'), { recursive: true });
  const db = new Database(srcPath, { readonly: true });
  try {
    const escaped = destPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
}

function copyTree(src: string, dest: string): void {
  if (!existsSync(src)) return;
  cpSync(src, dest, { recursive: true });
}

function collectFiles(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, base));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function buildManifest(stagingRoot: string, relPaths: string[]): BackupManifest {
  const files = relPaths
    .filter((p) => existsSync(join(stagingRoot, p)))
    .map((p) => {
      const abs = join(stagingRoot, p);
      const { sha256, bytes } = sha256File(abs);
      return { path: p.replace(/\\/g, '/'), sha256, bytes };
    });
  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    aegis_version: '0.0.1',
    files,
  };
}

export interface BackupOptions {
  root: string;
  out?: string;
}

export function runBackup(opts: BackupOptions): number {
  const layout = readInstallLayout(opts.root);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = opts.out ?? join(opts.root, `aegis-backup-${ts}.tar.gz`);
  const staging = join(opts.root, `.aegis-backup-staging-${Date.now()}`);
  mkdirSync(staging, { recursive: true });

  try {
    const dataStaging = join(staging, 'data');
    mkdirSync(dataStaging, { recursive: true });
    for (const name of ['queue.db', 'memory.db', 'audit.db'] as const) {
      vacuumDbSnapshot(join(layout.dataDir, name), join(dataStaging, name));
    }
    copyTree(layout.workspaceDir, join(staging, 'workspace'));
    copyTree(layout.skillsDir, join(staging, 'skills'));
    cpSync(layout.configPath, join(staging, 'aegis.config.json'));

    const relPaths = [
      'aegis.config.json',
      'data/queue.db',
      'data/memory.db',
      'data/audit.db',
      ...collectFiles(join(staging, 'workspace'), join(staging, 'workspace')).map(
        (p) => `workspace/${p}`,
      ),
      ...collectFiles(join(staging, 'skills'), join(staging, 'skills')).map((p) => `skills/${p}`),
    ];
    const manifest = buildManifest(staging, relPaths);
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    execFileSync('tar', ['-czf', outPath, '-C', staging, '.'], { stdio: 'inherit' });
    console.log(`Backup written: ${outPath}`);
    console.warn('Store backup offline; archive contains full DB state.');
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface RestoreOptions {
  root: string;
  archive: string;
  force?: boolean;
}

export function runRestore(opts: RestoreOptions): number {
  if (!existsSync(opts.archive)) {
    console.error(`Archive not found: ${opts.archive}`);
    return 1;
  }
  const staging = join(opts.root, `.aegis-restore-staging-${Date.now()}`);
  mkdirSync(staging, { recursive: true });

  try {
    execFileSync('tar', ['-xzf', opts.archive, '-C', staging], { stdio: 'inherit' });
    const layout = readInstallLayout(opts.root, join(staging, 'aegis.config.json'));
    const manifestPath = join(staging, 'manifest.json');
    if (!existsSync(manifestPath)) {
      console.error('Invalid archive: manifest.json missing');
      return 1;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
    if (manifest.schema_version !== BACKUP_SCHEMA_VERSION) {
      console.error(`Unsupported manifest schema_version: ${manifest.schema_version}`);
      return 1;
    }
    for (const f of manifest.files) {
      const abs = join(staging, f.path);
      if (!existsSync(abs)) {
        console.error(`Archive corrupt: missing ${f.path}`);
        return 1;
      }
      const { sha256 } = sha256File(abs);
      if (sha256 !== f.sha256) {
        console.error(`Checksum mismatch: ${f.path}`);
        return 1;
      }
    }

    const targets = [
      layout.configPath,
      join(layout.dataDir, 'queue.db'),
      join(layout.dataDir, 'memory.db'),
      join(layout.dataDir, 'audit.db'),
      layout.workspaceDir,
      layout.skillsDir,
    ];
    const occupied = targets.filter((t) => existsSync(t));
    if (occupied.length > 0 && !opts.force) {
      console.error('Target install is not empty. Stop host and re-run with --force');
      return 1;
    }

    if (opts.force && existsSync(layout.dataDir)) {
      const bak = `${layout.dataDir}.bak-${Date.now()}`;
      cpSync(layout.dataDir, bak, { recursive: true });
    }

    mkdirSync(layout.dataDir, { recursive: true });
    mkdirSync(layout.workspaceDir, { recursive: true });
    mkdirSync(layout.skillsDir, { recursive: true });

    cpSync(join(staging, 'aegis.config.json'), layout.configPath);
    for (const name of ['queue.db', 'memory.db', 'audit.db']) {
      const src = join(staging, 'data', name);
      if (existsSync(src)) cpSync(src, join(layout.dataDir, name));
    }
    if (existsSync(join(staging, 'workspace'))) {
      rmSync(layout.workspaceDir, { recursive: true, force: true });
      cpSync(join(staging, 'workspace'), layout.workspaceDir, { recursive: true });
    }
    if (existsSync(join(staging, 'skills'))) {
      rmSync(layout.skillsDir, { recursive: true, force: true });
      cpSync(join(staging, 'skills'), layout.skillsDir, { recursive: true });
    }

    console.log(`Restored from ${basename(opts.archive)} → ${opts.root}`);
    console.log('Run: aegis-setup verify');
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function backupUsage(): void {
  console.log(`Usage: aegis-setup backup [--dir <install>] [--out <file.tar.gz>]
       aegis-setup restore <archive.tar.gz> [--dir <install>] [--force]`);
}
