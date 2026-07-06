/**
 * Соединение с SQLite и применение миграций (docs/MEMORY_SCHEMA.md).
 * PRAGMA-дисциплина едина для всех трёх файлов БД; один писатель на файл.
 */
import Database from 'better-sqlite3';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Идемпотентно применяет миграцию: выполняется только если PRAGMA user_version < version.
 * Миграции нумерованные и только вперёд (docs/REPO_LAYOUT.md).
 */
export function applyMigration(db: Database.Database, sql: string, version: number): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= version) return;
  db.transaction(() => {
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  })();
}
