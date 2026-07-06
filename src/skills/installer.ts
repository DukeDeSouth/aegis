/**
 * Установка навыка из git с pinned ref (owner-only, fail-closed).
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import type { KnowledgeStore } from '../memory/knowledge.ts';
import { SkillRegistry } from './registry.ts';
import { scanRejects } from './scanner.ts';
import { parseManifest, validateManifestFile } from './validate.ts';
import type { InstallResult } from './types.ts';

export type GitExecFn = (args: string[], cwd?: string) => Promise<void>;

function defaultGitExec(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${err.message}`));
      else resolve();
    });
  });
}

export interface SkillInstallerOptions {
  skillsDir: string;
  registry: SkillRegistry;
  knowledge: KnowledgeStore;
  gitExec?: GitExecFn;
}

function findSkillRoot(cloneDir: string): string {
  if (statSync(join(cloneDir, 'manifest.json'), { throwIfNoEntry: false })) return cloneDir;
  for (const c of readdirSync(cloneDir)) {
    const p = join(cloneDir, c);
    if (
      statSync(p).isDirectory() &&
      statSync(join(p, 'manifest.json'), { throwIfNoEntry: false })
    ) {
      return p;
    }
  }
  throw new Error('no manifest.json in clone root');
}

export class SkillInstaller {
  private readonly skillsDir: string;
  private readonly registry: SkillRegistry;
  private readonly knowledge: KnowledgeStore;
  private readonly gitExec: GitExecFn;

  constructor(opts: SkillInstallerOptions) {
    this.skillsDir = opts.skillsDir;
    this.registry = opts.registry;
    this.knowledge = opts.knowledge;
    this.gitExec = opts.gitExec ?? defaultGitExec;
  }

  /** spec = `https://host/repo.git#commit` */
  async installFromGit(spec: string): Promise<InstallResult> {
    const hash = spec.lastIndexOf('#');
    if (hash <= 0) throw new Error('spec must be url#commit');
    const url = spec.slice(0, hash);
    const ref = spec.slice(hash + 1);
    if (!url.startsWith('https://') && !url.startsWith('git@')) {
      throw new Error('only https:// or git@ URLs allowed');
    }
    if (!ref || ref.includes('/') || ref.includes('..')) {
      throw new Error('invalid pinned ref');
    }

    const tmp = mkdtempSync(join(tmpdir(), 'aegis-skill-'));
    try {
      await this.gitExec(['clone', '--depth', '1', url, tmp]);
      await this.gitExec(['checkout', ref], tmp);
      return this.installFromDir(findSkillRoot(tmp), `${url}#${ref}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Копирование в skills_dir + knowledge row (тесты и post-clone). */
  installFromDir(srcDir: string, skillRef: string): InstallResult {
    const manifestPath = join(srcDir, 'manifest.json');
    const skillPath = join(srcDir, 'SKILL.md');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const skillMd = readFileSync(skillPath, 'utf8');
    const dirName = srcDir.split('/').pop()!;
    const validation = validateManifestFile(raw, srcDir, dirName, skillMd);
    if (!validation.ok) {
      throw new Error(`manifest invalid: ${validation.errors.join('; ')}`);
    }
    const scanErr = scanRejects(srcDir);
    if (scanErr) throw new Error(`scanner rejected: ${scanErr}`);

    const manifest = parseManifest(raw);
    const dest = join(this.skillsDir, manifest.name);
    if (statSync(dest, { throwIfNoEntry: false })) {
      rmSync(dest, { recursive: true, force: true });
    }
    cpSync(srcDir, dest, { recursive: true });
    this.registry.reload();

    const knowledgeId = this.knowledge.insertSkill({
      title: manifest.name,
      body: `Skill ${manifest.name}@${manifest.version}`,
      provenance: 'owner',
      skillRef,
    });
    return { name: manifest.name, ref: skillRef, knowledgeId };
  }
}
