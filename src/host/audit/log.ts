/**
 * Tamper-evident audit log поверх audit.db (docs/MEMORY_SCHEMA.md).
 * Append-only обеспечивают триггеры схемы; целостность — hash chain:
 * entry_hash = sha256(ts|actor|action|decision|payload_hash|prev_hash),
 * prev_hash первой записи — 'genesis'.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ActionClass } from '../gate/types.ts';

export type AuditDecision = 'allow' | 'deny' | 'confirm_required' | 'info';

export interface AuditEvent {
  actor: string;
  action: string;
  actionClass?: ActionClass;
  decision: AuditDecision;
  /** Сериализуется в JSON и хешируется; сырые секреты сюда попадать не должны. */
  payload?: unknown;
}

export type ChainVerification = { ok: true; entries: number } | { ok: false; brokenAtId: number };

interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  decision: string;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
}

const GENESIS = 'genesis';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function computeEntryHash(row: Omit<AuditRow, 'id' | 'entry_hash'>): string {
  return sha256(
    [row.ts, row.actor, row.action, row.decision, row.payload_hash, row.prev_hash].join('|'),
  );
}

export class AuditLog {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private lastHash: string | undefined;

  constructor(db: Database.Database, opts: { now?: () => number } = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  append(event: AuditEvent): void {
    const ts = this.now();
    const payloadHash = sha256(JSON.stringify(event.payload ?? null));
    const prevHash = (this.lastHash ??= this.readLastHash());
    const entryHash = computeEntryHash({
      ts,
      actor: event.actor,
      action: event.action,
      decision: event.decision,
      payload_hash: payloadHash,
      prev_hash: prevHash,
    });
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, actor, action, action_class, decision, payload_hash, prev_hash, entry_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        event.actor,
        event.action,
        event.actionClass ?? null,
        event.decision,
        payloadHash,
        prevHash,
        entryHash,
      );
    this.lastHash = entryHash;
  }

  /** Детерминированная проверка цепочки: пересчёт хешей и связности от genesis. */
  verifyChain(): ChainVerification {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY id').all() as AuditRow[];
    let prev = GENESIS;
    for (const row of rows) {
      if (row.prev_hash !== prev || computeEntryHash(row) !== row.entry_hash) {
        return { ok: false, brokenAtId: row.id };
      }
      prev = row.entry_hash;
    }
    return { ok: true, entries: rows.length };
  }

  private readLastHash(): string {
    const row = this.db
      .prepare('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { entry_hash: string } | undefined;
    return row?.entry_hash ?? GENESIS;
  }
}
