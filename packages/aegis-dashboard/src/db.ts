/**
 * Read-only SQLite (F11): физическая граница — файл открыт без права записи.
 */
import Database from 'better-sqlite3';

export function openRoDb(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}
