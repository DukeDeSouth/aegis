/**
 * Кэш выжимок web.fetch (F2): url_hash → digest, TTL в ядре.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

export class WebCacheStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(hash: string): { url: string; digest: string; fetchedAt: number } | undefined {
    const row = this.db
      .prepare(`SELECT url, digest, fetched_at FROM web_cache WHERE url_hash = ?`)
      .get(hash) as { url: string; digest: string; fetched_at: number } | undefined;
    if (!row) return undefined;
    return { url: row.url, digest: row.digest, fetchedAt: row.fetched_at };
  }

  put(hash: string, url: string, digest: string, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO web_cache (url_hash, url, digest, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(url_hash) DO UPDATE SET url=excluded.url, digest=excluded.digest, fetched_at=excluded.fetched_at`,
      )
      .run(hash, url, digest, fetchedAt);
  }

  isFresh(fetchedAt: number, ttlSec: number, now: number): boolean {
    return now - fetchedAt <= ttlSec * 1000;
  }
}
