/**
 * Точка входа host-процесса: конфиг → миграции → эхо-петля + Telegram-адаптер →
 * graceful shutdown. Запуск: npm start (нативное исполнение .ts, Node >= 24).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema } from '../config/schema.ts';
import { OpenAiCompatClient } from '../llm/client.ts';
import { EpisodeStore } from '../memory/episodes.ts';
import { KnowledgeStore } from '../memory/knowledge.ts';
import { CurationRunner } from '../memory/curation.ts';
import { PromotionGate } from '../memory/promotion.ts';
import { MemorySnapshot } from '../memory/snapshot.ts';
import { KnowledgeVerifier } from '../memory/verifier.ts';
import { applyMigration, openDb } from '../memory/db.ts';
import { TelegramAdapter } from './adapter/adapter.ts';
import { ChannelState } from './adapter/state.ts';
import { TelegramClient } from './adapter/telegram-client.ts';
import { AuditLog } from './audit/log.ts';
import { BudgetEngine } from './budget/engine.ts';
import { PendingStore } from './gate/pending.ts';
import { ScheduleRunner } from './scheduler/scheduler.ts';
import type { ScheduleEntry } from './scheduler/types.ts';
import { Orchestrator } from './orchestrator/loop.ts';
import { computeReuseMetrics } from '../memory/metrics.ts';
import { QuarantineProcessor } from './quarantine/processor.ts';
import { QueueStore } from './queue/store.ts';
import { DockerSandboxRunner } from '../sandbox/runner.ts';
import { SkillDryRun } from '../skills/dry-run.ts';
import { SkillInstaller } from '../skills/installer.ts';
import { SkillRegistry } from '../skills/registry.ts';

function loadConfig(): ReturnType<typeof configSchema.parse> {
  const path = process.env.AEGIS_CONFIG ?? './aegis.config.json';
  const raw = readFileSync(path, 'utf8');
  return configSchema.parse(JSON.parse(raw));
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.data_dir, { recursive: true });
  mkdirSync(config.skills_dir, { recursive: true });
  const snapshotsDir = join(config.data_dir, 'snapshots');
  mkdirSync(snapshotsDir, { recursive: true });

  const queueDb = openDb(join(config.data_dir, 'queue.db'));
  const memoryPath = join(config.data_dir, 'memory.db');
  const memoryDb = openDb(memoryPath);
  const auditDb = openDb(join(config.data_dir, 'audit.db'));
  applyMigration(queueDb, migrationSql('0001-queue.sql'), 1);
  applyMigration(queueDb, migrationSql('0002-queue.sql'), 2);
  applyMigration(queueDb, migrationSql('0003-queue.sql'), 3);
  applyMigration(queueDb, migrationSql('0004-budget.sql'), 4);
  applyMigration(memoryDb, migrationSql('0001-memory.sql'), 1);
  applyMigration(auditDb, migrationSql('0001-audit.sql'), 1);

  const queues = new QueueStore(queueDb);
  const audit = new AuditLog(auditDb);
  const llm = new OpenAiCompatClient(config.llm.p_llm);
  const qLlm = new OpenAiCompatClient(config.llm.q_llm);
  const quarantine = new QuarantineProcessor(qLlm, {
    maxTokens: config.llm.q_llm.max_tokens,
  });
  const pending = new PendingStore(queueDb);
  const episodes = new EpisodeStore(memoryDb);
  const knowledge = new KnowledgeStore(memoryDb);
  const promotion = new PromotionGate(memoryDb);
  const verifier = new KnowledgeVerifier(memoryDb, knowledge, { promotion });
  const snapshot = new MemorySnapshot(memoryDb, memoryPath, snapshotsDir);
  const curation = new CurationRunner(memoryDb, knowledge, promotion, snapshot);
  const skills = new SkillRegistry(config.skills_dir);
  const skillInstaller = new SkillInstaller({
    skillsDir: config.skills_dir,
    registry: skills,
    knowledge,
  });
  const sandbox = new DockerSandboxRunner({
    image: process.env.AEGIS_SANDBOX_IMAGE ?? 'alpine:3.20',
    internalNetwork: process.env.AEGIS_INTERNAL_NETWORK ?? 'aegis-internal',
  });
  const skillDryRun = new SkillDryRun({
    registry: skills,
    sandbox,
    promotion,
    knowledge,
  });
  const budget = config.budget
    ? new BudgetEngine(queueDb, {
        dailyTokenLimit: config.budget.daily_token_limit,
        reserveForOwner: config.budget.reserve_for_owner,
      })
    : undefined;
  const orchestrator = new Orchestrator(queues, audit, llm, pending, {
    episodes,
    knowledge,
    promotion,
    verifier,
    curation,
    quarantine,
    skills,
    skillInstaller,
    skillDryRun,
    getReuseMetrics: () => computeReuseMetrics(memoryDb),
    learning: config.learning,
    ...(budget !== undefined ? { budget } : {}),
    ...(config.budget?.notify_session_id !== undefined
      ? { ownerNotifySessionId: config.budget.notify_session_id }
      : {}),
  });
  const scheduleEntries: ScheduleEntry[] = config.schedules.map((s) => ({
    id: s.id,
    cron: s.cron,
    text: s.text,
    ...(s.session_id !== undefined ? { session_id: s.session_id } : {}),
  }));
  const scheduler =
    scheduleEntries.length > 0
      ? new ScheduleRunner(queues, queueDb, audit, { schedules: scheduleEntries })
      : undefined;

  const tgClient = new TelegramClient(config.telegram.bot_token_ref, {
    pollTimeoutS: config.telegram.poll_timeout_s,
  });
  const channelState = new ChannelState(queueDb);
  const adapter = new TelegramAdapter(
    tgClient,
    queues,
    audit,
    channelState,
    config.telegram.pairing_code_ref,
  );

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());

  audit.append({ actor: 'host', action: 'host.started', decision: 'info' });
  console.log(`aegis host started (data: ${config.data_dir}); orchestrator + telegram adapter`);

  const runners = [orchestrator.run(ac.signal), adapter.run(ac.signal)];
  if (scheduler) runners.push(scheduler.run(ac.signal));
  await Promise.all(runners);

  audit.append({ actor: 'host', action: 'host.stopped', decision: 'info' });
  console.log('aegis host stopped');
}

main().catch((err: unknown) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
