/**
 * Live LLM harness: реальные P/Q клиенты из aegis.config.json + .env.aegis.
 * Не входит в CI — требует ключи и сеть (Groq и т.д.).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, type AegisConfig } from '../../src/config/schema.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import type { OrchestratorOptions } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import { OpenAiCompatClient } from '../../src/llm/client.ts';
import type { LlmClient } from '../../src/llm/types.ts';
import { DEFAULT_MEMORY_CONTEXT } from '../../src/memory/context.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import type Database from 'better-sqlite3';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** Подгружает .env.aegis если ключи ещё не в process.env. */
export function loadHostEnv(): void {
  const envPath = join(REPO_ROOT, '.env.aegis');
  if (!existsSync(envPath)) return;
  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
}

export function liveLlmAvailable(): boolean {
  loadHostEnv();
  return (
    (process.env.AEGIS_P_LLM_KEY?.length ?? 0) > 10 &&
    (process.env.AEGIS_Q_LLM_KEY?.length ?? 0) > 10
  );
}

export function loadLiveConfig(): AegisConfig {
  const configPath =
    process.env.AEGIS_CONFIG ?? join(REPO_ROOT, 'aegis.config.json');
  if (!existsSync(configPath)) {
    throw new Error(`Live config missing: ${configPath}`);
  }
  return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
}

export function makeLiveClients(config: AegisConfig): { pLlm: LlmClient; qLlm: LlmClient } {
  return {
    pLlm: new OpenAiCompatClient(config.llm.p_llm, { requestTimeoutMs: 90_000 }),
    qLlm: new OpenAiCompatClient(config.llm.q_llm, { requestTimeoutMs: 90_000 }),
  };
}

export function migration(name: string): string {
  return readFileSync(join(REPO_ROOT, 'migrations', name), 'utf8');
}

export interface LiveWorld {
  readonly tmpDir: string;
  readonly queues: QueueStore;
  readonly audit: AuditLog;
  readonly auditDb: Database.Database;
  readonly queueDb: Database.Database;
  readonly memoryDb: Database.Database;
  readonly episodes: EpisodeStore;
  readonly knowledge: KnowledgeStore;
  readonly now: { value: number };
}

export function makeLiveWorld(prefix = 'aegis-live-'): LiveWorld {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  const now = { value: Date.now() };
  const queueDb = openDb(join(tmpDir, 'queue.db'));
  const auditDb = openDb(join(tmpDir, 'audit.db'));
  const memoryDb = openDb(join(tmpDir, 'memory.db'));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  applyMigration(memoryDb, migration('0001-memory.sql'), 1);
  applyMigration(memoryDb, migration('0002-memory.sql'), 2);
  return {
    tmpDir,
    queues: new QueueStore(queueDb, { visibilityTimeoutMs: 60_000, now: () => now.value }),
    audit: new AuditLog(auditDb, { now: () => now.value }),
    auditDb,
    queueDb,
    memoryDb,
    episodes: new EpisodeStore(memoryDb, { now: () => now.value }),
    knowledge: new KnowledgeStore(memoryDb, { now: () => now.value }),
    now,
  };
}

export function destroyLiveWorld(w: LiveWorld): void {
  rmSync(w.tmpDir, { recursive: true, force: true });
}

export function makeLiveOrchestrator(
  w: LiveWorld,
  pLlm: LlmClient,
  opts: OrchestratorOptions & { qLlm?: LlmClient } = {},
): Orchestrator {
  const pending = new PendingStore(w.queueDb, { now: () => w.now.value });
  const { qLlm, ...rest } = opts;
  return new Orchestrator(w.queues, w.audit, pLlm, pending, {
    episodes: w.episodes,
    knowledge: w.knowledge,
    memoryContext: DEFAULT_MEMORY_CONTEXT,
    ...rest,
  });
}

export function auditActions(db: Database.Database): string[] {
  return (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map(
    (r) => r.action,
  );
}

export function claimOutboundText(queues: QueueStore, worker = 'live-probe'): string | undefined {
  const msg = queues.claim('outbound', worker);
  if (!msg) return undefined;
  return (JSON.parse(msg.payload) as { text: string }).text;
}

/** Мягкая проверка: хотя бы один из паттернов встречается в тексте (case-insensitive). */
export function textMatchesAny(text: string, patterns: RegExp[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => p.test(lower));
}
