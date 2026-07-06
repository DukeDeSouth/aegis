import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import type Database from 'better-sqlite3';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-audit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const migrationSql = readFileSync(
  new URL('../../migrations/0001-audit.sql', import.meta.url),
  'utf8',
);

function makeAudit(name: string): { audit: AuditLog; db: Database.Database } {
  const db = openDb(join(tmp, name));
  applyMigration(db, migrationSql, 1);
  return { audit: new AuditLog(db, { now: () => 1_750_000_000_000 }), db };
}

describe('AuditLog', () => {
  it('цепочка из трёх записей верифицируется, начинается с genesis', () => {
    const { audit, db } = makeAudit('chain.db');
    audit.append({ actor: 'host', action: 'host.started', decision: 'info' });
    audit.append({
      actor: 'orchestrator',
      action: 'message.claimed',
      decision: 'info',
      payload: { id: 1 },
    });
    audit.append({
      actor: 'gate',
      action: 'skill.run',
      actionClass: 'read-only',
      decision: 'allow',
    });

    expect(audit.verifyChain()).toEqual({ ok: true, entries: 3 });
    const first = db.prepare('SELECT prev_hash FROM audit_log ORDER BY id LIMIT 1').get() as {
      prev_hash: string;
    };
    expect(first.prev_hash).toBe('genesis');
  });

  it('подделка записи обнаруживается verifyChain', () => {
    const { audit, db } = makeAudit('tamper.db');
    audit.append({ actor: 'host', action: 'host.started', decision: 'info' });
    audit.append({ actor: 'orchestrator', action: 'message.processed', decision: 'info' });

    // Подделка в обход append-only: пересоздаём таблицу без триггеров (симуляция атаки на файл).
    db.exec(`
      CREATE TABLE tampered AS SELECT * FROM audit_log;
      UPDATE tampered SET action = 'message.hidden' WHERE id = 2;
      DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;
      DELETE FROM audit_log;
      INSERT INTO audit_log SELECT * FROM tampered;
    `);

    expect(audit.verifyChain()).toEqual({ ok: false, brokenAtId: 2 });
  });

  it('после рестарта процесса цепочка продолжается (prev_hash из БД)', () => {
    const { audit, db } = makeAudit('restart.db');
    audit.append({ actor: 'host', action: 'host.started', decision: 'info' });

    const restarted = new AuditLog(db, { now: () => 1_750_000_000_001 });
    restarted.append({ actor: 'host', action: 'host.stopped', decision: 'info' });

    expect(restarted.verifyChain()).toEqual({ ok: true, entries: 2 });
  });

  it('пустой журнал валиден', () => {
    const { audit } = makeAudit('empty.db');
    expect(audit.verifyChain()).toEqual({ ok: true, entries: 0 });
  });
});
