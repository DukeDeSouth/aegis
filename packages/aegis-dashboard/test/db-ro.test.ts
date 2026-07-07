import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openRoDb } from '../src/db.ts';
import { applyMigration, openDb } from '../../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-dash-ro-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('openRoDb', () => {
  it('rejects UPDATE on readonly connection', () => {
    const path = join(tmp, 'ro.db');
    const db = openDb(path);
    applyMigration(db, migration('0001-queue.sql'), 1);
    db.close();

    const ro = openRoDb(path);
    expect(() => ro.prepare(`UPDATE messages SET dead = 1`).run()).toThrow();
    ro.close();
  });
});
