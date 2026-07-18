import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../../src/memory/db.ts';
import { runBackup, runRestore } from '../src/backup.ts';

const root = mkdtempSync(join(tmpdir(), 'aegis-setup-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('aegis-setup backup (S4)', () => {
  it('backup → restore round-trip preserves marker file', () => {
    const install = join(root, 'install');
    const dataDir = join(install, 'data');
    const skillsDir = join(install, 'skills');
    const workspaceDir = join(dataDir, 'workspace');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(install, 'aegis.config.json'),
      JSON.stringify({ data_dir: './data', skills_dir: './skills' }),
    );
    writeFileSync(join(workspaceDir, 'note.txt'), 'hello-backup', 'utf8');

    const queueDb = openDb(join(dataDir, 'queue.db'));
    const memoryDb = openDb(join(dataDir, 'memory.db'));
    const auditDb = openDb(join(dataDir, 'audit.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    queueDb.close();
    memoryDb.close();
    auditDb.close();

    const archive = join(root, 'backup.tar.gz');
    expect(runBackup({ root: install, out: archive })).toBe(0);
    expect(existsSync(archive)).toBe(true);

    const restoreTarget = join(root, 'restored');
    mkdirSync(restoreTarget, { recursive: true });
    expect(runRestore({ root: restoreTarget, archive, force: true })).toBe(0);
    expect(readFileSync(join(restoreTarget, 'data', 'workspace', 'note.txt'), 'utf8')).toBe(
      'hello-backup',
    );
  });
});
