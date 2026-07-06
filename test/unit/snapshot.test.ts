import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-snap-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

describe('MemorySnapshot', () => {
  it('create записывает файл и метаданные', () => {
    const dbPath = join(tmp, 'mem.db');
    const snapDir = join(tmp, 'snaps');
    const d = openDb(dbPath);
    const sql = readFileSync(new URL('../../migrations/0001-memory.sql', import.meta.url), 'utf8');
    applyMigration(d, sql, 1);
    d.prepare(
      `INSERT INTO knowledge (kind, title, body, provenance, created_at, updated_at)
       VALUES ('fact', 'T', 'B', 'owner', ?, ?)`,
    ).run(NOW, NOW);

    const snap = new MemorySnapshot(d, dbPath, snapDir, { now: () => NOW });
    const rec = snap.create('pre-curation');
    expect(existsSync(rec.path)).toBe(true);
    expect(rec.reason).toBe('pre-curation');
    const meta = d.prepare('SELECT COUNT(*) c FROM snapshots').get() as { c: number };
    expect(meta.c).toBe(1);
  });
});
