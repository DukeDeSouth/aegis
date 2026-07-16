/**
 * Read-only сбор данных для дашборда (F11).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { dbPaths, type DashboardConfig } from './config.ts';
import { openRoDb } from './db.ts';

const GENESIS = 'genesis';

export interface QueueRow {
  id: number;
  queue: string;
  payloadPreview: string;
  provenance: string;
  createdAt: number;
  claimedBy: string | null;
}

export interface PendingRow {
  token: string;
  actionId: string;
  chatId: number;
  originSessionId: string;
  requiredChannel: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  decision: string;
}

export interface SkillRow {
  name: string;
  version: string;
  code: boolean;
  requiresReview: boolean;
  invocations: number;
  successes: number;
  lastUsedAt: number | null;
}

export interface DashboardData {
  generatedAt: number;
  auditChainOk: boolean;
  auditEntries: number;
  auditBrokenAtId?: number;
  inbound: QueueRow[];
  outbound: QueueRow[];
  pending: PendingRow[];
  auditTail: AuditRow[];
  budget: { day: string; used: number; limit: number; backgroundBlocked: boolean };
  reuse: { injectable: number; used: number; reuseRate: number | null };
  skillReuse: { tracked: number; used: number; reuseRate: number | null };
  skills: SkillRow[];
  lastCuration: { snapshotId: number; reason: string; createdAt: number } | null;
  lastCurationAudit: AuditRow | null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function computeEntryHash(row: {
  ts: number;
  actor: string;
  action: string;
  decision: string;
  payload_hash: string;
  prev_hash: string;
}): string {
  return sha256(
    [row.ts, row.actor, row.action, row.decision, row.payload_hash, row.prev_hash].join('|'),
  );
}

export function verifyAuditChain(db: Database.Database): {
  ok: boolean;
  entries: number;
  brokenAtId?: number;
} {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as {
    id: number;
    ts: number;
    actor: string;
    action: string;
    decision: string;
    payload_hash: string;
    prev_hash: string;
    entry_hash: string;
  }[];
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev || computeEntryHash(row) !== row.entry_hash) {
      return { ok: false, entries: rows.length, brokenAtId: row.id };
    }
    prev = row.entry_hash;
  }
  return { ok: true, entries: rows.length };
}

function utcDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function payloadPreview(payload: string): string {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    if (p.kind === 'quarantine_content' && typeof p.body === 'string') {
      const src = typeof p.source === 'string' ? p.source : '?';
      return `[quarantine:${src}] ${p.body}`;
    }
    if (typeof p.text === 'string') return p.text;
    if (typeof p.kind === 'string') return String(p.kind);
  } catch {
    /* raw */
  }
  return payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
}

function listQueue(db: Database.Database, queue: string, limit: number): QueueRow[] {
  const rows = db
    .prepare(
      `SELECT id, queue, payload, provenance, created_at, claimed_by
       FROM messages WHERE queue = ? AND dead = 0
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(queue, limit) as {
    id: number;
    queue: string;
    payload: string;
    provenance: string;
    created_at: number;
    claimed_by: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    queue: r.queue,
    payloadPreview: payloadPreview(r.payload),
    provenance: r.provenance,
    createdAt: r.created_at,
    claimedBy: r.claimed_by,
  }));
}

function listPending(db: Database.Database, now: number): PendingRow[] {
  const has2fa = (
    db.prepare('PRAGMA table_info(pending_actions)').all() as { name: string }[]
  ).some((c) => c.name === 'origin_session_id');
  const rows = db
    .prepare(
      has2fa
        ? `SELECT token, action_id, chat_id, origin_session_id, required_channel, created_at, expires_at
           FROM pending_actions WHERE consumed = 0 AND expires_at > ? ORDER BY created_at DESC`
        : `SELECT token, action_id, chat_id, created_at, expires_at
           FROM pending_actions WHERE consumed = 0 AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(now) as {
    token: string;
    action_id: string;
    chat_id: number;
    origin_session_id?: string | null;
    required_channel?: string | null;
    created_at: number;
    expires_at: number;
  }[];
  return rows.map((r) => ({
    token: r.token,
    actionId: r.action_id,
    chatId: r.chat_id,
    originSessionId: r.origin_session_id ?? `tg:${r.chat_id}`,
    requiredChannel: r.required_channel ?? null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

function readBudget(db: Database.Database, limit: number, reserve: number, now: number) {
  const day = utcDay(now);
  const row = db
    .prepare(`SELECT tokens_used, limit_tokens FROM budget_daily WHERE day = ?`)
    .get(day) as { tokens_used: number; limit_tokens: number } | undefined;
  const used = row?.tokens_used ?? 0;
  const lim = row?.limit_tokens ?? limit;
  const schedulerCap = Math.max(0, lim - reserve);
  return { day, used, limit: lim, backgroundBlocked: used >= schedulerCap };
}

function readReuse(db: Database.Database) {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN epistemic_status IN ('corroborated', 'verified') THEN 1 ELSE 0 END) AS injectable,
         SUM(CASE WHEN epistemic_status IN ('corroborated', 'verified') AND use_count > 0 THEN 1 ELSE 0 END) AS used
       FROM knowledge`,
    )
    .get() as { injectable: number | null; used: number | null };
  const injectable = row.injectable ?? 0;
  const used = row.used ?? 0;
  return { injectable, used, reuseRate: injectable > 0 ? used / injectable : null };
}

function readSkillReuse(db: Database.Database) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS tracked,
              SUM(CASE WHEN invocations > 0 THEN 1 ELSE 0 END) AS used
       FROM skill_metrics`,
    )
    .get() as { tracked: number; used: number | null };
  const tracked = row.tracked ?? 0;
  const used = row.used ?? 0;
  return { tracked, used, reuseRate: tracked > 0 ? used / tracked : null };
}

function listSkills(skillsDir: string, memoryDb?: Database.Database): SkillRow[] {
  const metrics = new Map<string, { invocations: number; successes: number; lastUsedAt: number | null }>();
  if (memoryDb) {
    const rows = memoryDb
      .prepare(`SELECT skill_name, invocations, successes, last_used_at FROM skill_metrics`)
      .all() as {
      skill_name: string;
      invocations: number;
      successes: number;
      last_used_at: number | null;
    }[];
    for (const r of rows) {
      metrics.set(r.skill_name, {
        invocations: r.invocations,
        successes: r.successes,
        lastUsedAt: r.last_used_at,
      });
    }
  }

  const out: SkillRow[] = [];
  if (!existsSync(skillsDir)) return out;

  for (const entry of readdirSync(skillsDir)) {
    if (entry.startsWith('.')) continue;
    const dir = join(skillsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        version?: string;
        code?: boolean;
        requires_review?: boolean;
      };
      if (!manifest.name) continue;
      const m = metrics.get(manifest.name);
      out.push({
        name: manifest.name,
        version: manifest.version ?? '?',
        code: manifest.code === true,
        requiresReview: manifest.requires_review === true,
        invocations: m?.invocations ?? 0,
        successes: m?.successes ?? 0,
        lastUsedAt: m?.lastUsedAt ?? null,
      });
    } catch {
      /* skip invalid */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function lastSnapshot(memoryDb: Database.Database) {
  const row = memoryDb
    .prepare(
      `SELECT id, reason, created_at FROM snapshots
       WHERE reason LIKE '%curation%' OR reason = 'pre-curation'
       ORDER BY id DESC LIMIT 1`,
    )
    .get() as { id: number; reason: string; created_at: number } | undefined;
  return row ? { snapshotId: row.id, reason: row.reason, createdAt: row.created_at } : null;
}

function auditTail(db: Database.Database, limit: number): AuditRow[] {
  return (
    db
      .prepare(
        `SELECT id, ts, actor, action, decision FROM audit_log ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as AuditRow[]
  ).reverse();
}

function lastCurationAudit(db: Database.Database): AuditRow | null {
  const row = db
    .prepare(
      `SELECT id, ts, actor, action, decision FROM audit_log
       WHERE action = 'curation.completed' ORDER BY id DESC LIMIT 1`,
    )
    .get() as AuditRow | undefined;
  return row ?? null;
}

export function collectDashboardData(cfg: DashboardConfig, now = Date.now()): DashboardData {
  const paths = dbPaths(cfg);
  const queueDb = openRoDb(paths.queue);
  const auditDb = openRoDb(paths.audit);
  let memoryDb: Database.Database | undefined;
  try {
    memoryDb = openRoDb(paths.memory);
  } catch {
    memoryDb = undefined;
  }

  const chain = verifyAuditChain(auditDb);

  return {
    generatedAt: now,
    auditChainOk: chain.ok,
    auditEntries: chain.entries,
    ...(chain.brokenAtId !== undefined ? { auditBrokenAtId: chain.brokenAtId } : {}),
    inbound: listQueue(queueDb, 'inbound', 30),
    outbound: listQueue(queueDb, 'outbound', 30),
    pending: listPending(queueDb, now),
    auditTail: auditTail(auditDb, 40),
    budget: readBudget(queueDb, cfg.budgetLimit, cfg.budgetReserve, now),
    reuse: memoryDb ? readReuse(memoryDb) : { injectable: 0, used: 0, reuseRate: null },
    skillReuse: memoryDb
      ? readSkillReuse(memoryDb)
      : { tracked: 0, used: 0, reuseRate: null },
    skills: listSkills(cfg.skillsDir, memoryDb),
    lastCuration: memoryDb ? lastSnapshot(memoryDb) : null,
    lastCurationAudit: lastCurationAudit(auditDb),
  };
}
