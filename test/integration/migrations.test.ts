/**
 * Исполняемая спецификация схемы данных (docs/MEMORY_SCHEMA.md).
 * Каждая миграция применяется к чистому SQLite-файлу; проверяются
 * инварианты, которые схема обязана держать без участия кода ядра.
 */
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-migrations-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function freshDb(migration: string, dbName: string): Database.Database {
  const db = openDb(join(tmp, dbName));
  const sql = readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8');
  applyMigration(db, sql, 1);
  // Идемпотентность runner'а: повторное применение — no-op
  applyMigration(db, sql, 1);
  return db;
}

const NOW = 1_750_000_000_000;

describe('0001-queue.sql', () => {
  const db = freshDb('0001-queue.sql', 'queue.db');

  it('применяется к чистой БД и принимает валидное сообщение', () => {
    db.prepare(
      `INSERT INTO messages (queue, payload, provenance, created_at, visible_at)
       VALUES ('inbound', '{}', 'owner', ?, ?)`,
    ).run(NOW, NOW);
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 });
  });

  it('отклоняет неизвестную очередь и provenance (CHECK)', () => {
    const insert = db.prepare(
      `INSERT INTO messages (queue, payload, provenance, created_at, visible_at)
       VALUES (?, '{}', ?, ${NOW}, ${NOW})`,
    );
    expect(() => insert.run('sideways', 'owner')).toThrow(/CHECK/);
    expect(() => insert.run('inbound', 'martian')).toThrow(/CHECK/);
  });

  it('атомарный claim по образцу SQS возвращает строку и скрывает её', () => {
    const claimed = db
      .prepare(
        `UPDATE messages
         SET visible_at = :now + :timeout, claimed_by = :worker, attempts = attempts + 1
         WHERE id = (SELECT id FROM messages
                     WHERE queue = 'inbound' AND dead = 0 AND visible_at <= :now
                     ORDER BY created_at LIMIT 1)
         RETURNING *`,
      )
      .get({ now: NOW, timeout: 30_000, worker: 'w1' }) as { attempts: number } | undefined;
    expect(claimed?.attempts).toBe(1);

    const again = db
      .prepare(`SELECT id FROM messages WHERE queue = 'inbound' AND dead = 0 AND visible_at <= ?`)
      .get(NOW);
    expect(again).toBeUndefined();
  });
});

describe('0002-queue.sql', () => {
  const db = freshDb('0001-queue.sql', 'queue-v2.db');
  const sql = readFileSync(new URL('../../migrations/0002-queue.sql', import.meta.url), 'utf8');
  applyMigration(db, sql, 2);
  applyMigration(db, sql, 2); // идемпотентность: версия 2 уже применена

  it('channel_state принимает разрешённые ключи и отклоняет посторонние (CHECK)', () => {
    db.prepare(`INSERT INTO channel_state (key, value) VALUES ('owner_user_id', '42')`).run();
    db.prepare(`INSERT INTO channel_state (key, value) VALUES ('updates_offset', '100')`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM channel_state').get()).toEqual({ c: 2 });
    expect(() =>
      db.prepare(`INSERT INTO channel_state (key, value) VALUES ('anything', 'x')`).run(),
    ).toThrow(/CHECK/);
  });

  it('user_version = 2 после миграции', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(2);
  });
});

describe('0001-memory.sql', () => {
  const db = freshDb('0001-memory.sql', 'memory.db');

  function insertKnowledge(provenance: string, status: string): number {
    const res = db
      .prepare(
        `INSERT INTO knowledge (kind, title, body, epistemic_status, provenance, created_at, updated_at)
         VALUES ('fact', 't', 'b', ?, ?, ${NOW}, ${NOW})`,
      )
      .run(status, provenance);
    return Number(res.lastInsertRowid);
  }

  it('FTS5: эпизод находится полнотекстовым поиском, удаление синхронизируется', () => {
    db.prepare(
      `INSERT INTO episodes (session_id, role, content, provenance, created_at)
       VALUES ('s1', 'owner', 'встреча с бухгалтером в четверг', 'owner', ${NOW})`,
    ).run();
    const hit = db
      .prepare(`SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH 'бухгалтером'`)
      .get() as { rowid: number };
    expect(hit.rowid).toBe(1);

    db.prepare('DELETE FROM episodes WHERE id = 1').run();
    expect(
      db.prepare(`SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH 'бухгалтером'`).get(),
    ).toBeUndefined();
  });

  it('V4: недоверенный provenance не может родиться выше unverified', () => {
    expect(() => insertKnowledge('quarantine', 'verified')).toThrow(/unverified/);
    expect(() => insertKnowledge('background', 'corroborated')).toThrow(/unverified/);
    expect(insertKnowledge('quarantine', 'unverified')).toBeGreaterThan(0);
  });

  it('kind=skill требует skill_ref (CHECK)', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO knowledge (kind, title, body, provenance, created_at, updated_at)
           VALUES ('skill', 't', 'b', 'owner', ${NOW}, ${NOW})`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('promotion в corroborated требует детерминированного evidence', () => {
    const id = insertKnowledge('quarantine', 'unverified');
    const promote = db.prepare(
      `UPDATE knowledge SET epistemic_status = 'corroborated' WHERE id = ?`,
    );
    expect(() => promote.run(id)).toThrow(/deterministic evidence/);

    db.prepare(
      `INSERT INTO evidence (knowledge_id, evidence_type, summary, created_at)
       VALUES (?, 'test_pass', 'green run', ${NOW})`,
    ).run(id);
    promote.run(id);
    expect(db.prepare('SELECT epistemic_status s FROM knowledge WHERE id = ?').get(id)).toEqual({
      s: 'corroborated',
    });
  });

  it('promotion в verified требует владельца или независимого источника', () => {
    const id = insertKnowledge('owner', 'unverified');
    const verify = db.prepare(`UPDATE knowledge SET epistemic_status = 'verified' WHERE id = ?`);
    expect(() => verify.run(id)).toThrow(/owner confirmation/);

    db.prepare(
      `INSERT INTO evidence (knowledge_id, evidence_type, summary, created_at)
       VALUES (?, 'owner_confirmation', 'owner said yes', ${NOW})`,
    ).run(id);
    verify.run(id);
    expect(db.prepare('SELECT epistemic_status s FROM knowledge WHERE id = ?').get(id)).toEqual({
      s: 'verified',
    });
  });

  it('evidence: summary ограничен 2000 символами, каскад при удалении знания', () => {
    const id = insertKnowledge('owner', 'unverified');
    expect(() =>
      db
        .prepare(
          `INSERT INTO evidence (knowledge_id, evidence_type, summary, created_at)
           VALUES (?, 'test_pass', ?, ${NOW})`,
        )
        .run(id, 'x'.repeat(2001)),
    ).toThrow(/CHECK/);

    db.prepare(
      `INSERT INTO evidence (knowledge_id, evidence_type, summary, created_at)
       VALUES (?, 'test_pass', 'ok', ${NOW})`,
    ).run(id);
    db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
    expect(db.prepare('SELECT COUNT(*) c FROM evidence WHERE knowledge_id = ?').get(id)).toEqual({
      c: 0,
    });
  });
});

describe('0003-queue.sql', () => {
  const db = freshDb('0001-queue.sql', 'queue-v3.db');
  const sql = readFileSync(new URL('../../migrations/0003-queue.sql', import.meta.url), 'utf8');
  applyMigration(db, sql, 3);
  applyMigration(db, sql, 3);

  it('pending_actions принимает валидную запись и отклоняет consumed вне 0/1', () => {
    db.prepare(
      `INSERT INTO pending_actions (token, action_id, payload, chat_id, created_at, expires_at, consumed)
       VALUES ('abc12345', 'action.dangerous', '{}', 10, ?, ?, 0)`,
    ).run(NOW, NOW + 60_000);
    expect(db.prepare('SELECT COUNT(*) c FROM pending_actions').get()).toEqual({ c: 1 });
    expect(() =>
      db
        .prepare(
          `INSERT INTO pending_actions (token, action_id, payload, chat_id, created_at, expires_at, consumed)
         VALUES ('bad', 'x', '{}', 1, ?, ?, 2)`,
        )
        .run(NOW, NOW + 60_000),
    ).toThrow(/CHECK/);
  });

  it('user_version = 3 после миграции', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });
});

describe('0008-queue.sql', () => {
  const db = freshDb('0001-queue.sql', 'queue-v8.db');
  applyMigration(db, readFileSync(new URL('../../migrations/0002-queue.sql', import.meta.url), 'utf8'), 2);
  const sql = readFileSync(new URL('../../migrations/0008-queue.sql', import.meta.url), 'utf8');
  applyMigration(db, sql, 8);
  applyMigration(db, sql, 8);

  it('channel_state принимает discord и email ключи (CHECK)', () => {
    db.prepare(`INSERT INTO channel_state (key, value) VALUES ('discord_owner_user_id', 'u1')`).run();
    db.prepare(`INSERT INTO channel_state (key, value) VALUES ('discord_last_sequence', '10')`).run();
    db.prepare(`INSERT INTO channel_state (key, value) VALUES ('email_last_uid', '3')`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM channel_state').get()).toEqual({ c: 3 });
    expect(() =>
      db.prepare(`INSERT INTO channel_state (key, value) VALUES ('smtp_password', 'x')`).run(),
    ).toThrow(/CHECK/);
  });

  it('user_version = 8 после миграции', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(8);
  });
});

describe('0001-audit.sql', () => {
  const db = freshDb('0001-audit.sql', 'audit.db');

  it('применяется и принимает запись с hash chain', () => {
    db.prepare(
      `INSERT INTO audit_log (ts, actor, action, action_class, decision, payload_hash, prev_hash, entry_hash)
       VALUES (${NOW}, 'gate', 'skill.run', 'read-only', 'allow', 'p0', 'genesis', 'e0')`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) c FROM audit_log').get()).toEqual({ c: 1 });
  });

  it('append-only: UPDATE и DELETE запрещены триггерами', () => {
    expect(() => db.prepare(`UPDATE audit_log SET action = 'tampered' WHERE id = 1`).run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run()).toThrow(/append-only/);
  });
});
