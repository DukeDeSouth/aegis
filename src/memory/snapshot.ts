/**
 * Снапшоты памяти: VACUUM INTO + метаданные (Sprint 6).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

export interface SnapshotRecord {
  id: number;
  path: string;
  reason: string;
  createdAt: number;
}

export interface MemorySnapshotOptions {
  now?: () => number;
}

export class MemorySnapshot {
  private readonly db: Database.Database;
  private readonly snapshotsDir: string;
  private readonly dbPath: string;
  private readonly now: () => number;

  constructor(
    db: Database.Database,
    dbPath: string,
    snapshotsDir: string,
    opts: MemorySnapshotOptions = {},
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.snapshotsDir = snapshotsDir;
    this.now = opts.now ?? Date.now;
    mkdirSync(snapshotsDir, { recursive: true });
  }

  create(reason: string): SnapshotRecord {
    const ts = this.now();
    const fileName = `memory-${ts}.db`;
    const destPath = join(this.snapshotsDir, fileName);
    const escaped = destPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);

    const res = this.db
      .prepare(`INSERT INTO snapshots (path, reason, created_at) VALUES (?, ?, ?)`)
      .run(destPath, reason, ts);

    return {
      id: Number(res.lastInsertRowid),
      path: destPath,
      reason,
      createdAt: ts,
    };
  }

  get(id: number): SnapshotRecord | undefined {
    const row = this.db
      .prepare('SELECT id, path, reason, created_at FROM snapshots WHERE id = ?')
      .get(id) as { id: number; path: string; reason: string; created_at: number } | undefined;
    if (!row) return undefined;
    return { id: row.id, path: row.path, reason: row.reason, createdAt: row.created_at };
  }

  /** Тестовый harness: подмена файла БД снимком. */
  rollback(snapshotId: number): void {
    const snap = this.get(snapshotId);
    if (!snap) throw new Error(`snapshot ${snapshotId} not found`);
    copyFileSync(snap.path, this.dbPath);
  }
}
