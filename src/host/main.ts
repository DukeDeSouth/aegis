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
import { ConsolidationRunner } from '../memory/consolidation.ts';
import { PromotionGate } from '../memory/promotion.ts';
import { MemorySnapshot } from '../memory/snapshot.ts';
import { KnowledgeVerifier } from '../memory/verifier.ts';
import { applyMigration, openDb } from '../memory/db.ts';
import { DEFAULT_MEMORY_CONTEXT, type MemoryContextConfig } from '../memory/context.ts';
import { TelegramAdapter } from './adapter/adapter.ts';
import { DiscordAdapter } from './adapter/discord/adapter.ts';
import { LiveDiscordClient } from './adapter/discord/client.ts';
import { EmailInputAdapter } from './adapter/email/adapter.ts';
import { NullEmailFetcher, BrokerHttpEmailFetcher } from './adapter/email/fetcher.ts';
import { WebChatAdapter } from './adapter/webchat/adapter.ts';
import { WEBCHAT_DEFAULT_SESSION } from './adapter/channel.ts';
import { episodesToHistoryMessages } from './adapter/webchat/history.ts';
import { MatrixAdapter } from './adapter/matrix/adapter.ts';
import { LiveMatrixClient } from './adapter/matrix/client.ts';
import { SlackAdapter } from './adapter/slack/adapter.ts';
import { LiveSlackClient } from './adapter/slack/client.ts';
import { ChannelState } from './adapter/state.ts';
import { TelegramClient } from './adapter/telegram-client.ts';
import { AuditLog } from './audit/log.ts';
import { BudgetEngine } from './budget/engine.ts';
import { PendingStore } from './gate/pending.ts';
import { ScheduleRunner } from './scheduler/scheduler.ts';
import { ReminderStore } from './scheduler/reminders.ts';
import type { ScheduleEntry } from './scheduler/types.ts';
import { Orchestrator } from './orchestrator/loop.ts';
import { computeReuseMetrics } from '../memory/metrics.ts';
import { computeSkillReuseMetrics } from '../skills/metrics.ts';
import { QuarantineProcessor } from './quarantine/processor.ts';
import { QueueStore } from './queue/store.ts';
import { SandboxWebFetcher } from './web/fetcher.ts';
import { SandboxVoiceTranscriber, SandboxVoiceSynthesizer } from './adapter/voice.ts';
import { WebCacheStore } from '../memory/web-cache.ts';
import { DockerSandboxRunner } from '../sandbox/runner.ts';
import { SkillDryRun } from '../skills/dry-run.ts';
import { SkillInstaller } from '../skills/installer.ts';
import { SkillRegistry } from '../skills/registry.ts';
import { SkillProposalRunner } from '../skills/proposal.ts';
import { SkillMetricsStore } from '../skills/metrics.ts';
import { SkillCurator } from '../skills/curator.ts';
import { WorkspaceStore } from './workspace.ts';
import { loadMcpRegistry } from '../mcp/registry.ts';
import { DelegatingMcpRunner, SandboxMcpRunner } from '../mcp/sandbox-runner.ts';
import { HttpMcpRunner, StdioMcpRunner } from '../mcp/runner.ts';
import {
  createHealthServer,
  sdNotifyReady,
  sdNotifyWatchdog,
  type HealthState,
} from './health.ts';

function loadConfig(): ReturnType<typeof configSchema.parse> {
  const path = process.env.AEGIS_CONFIG ?? './aegis.config.json';
  const raw = readFileSync(path, 'utf8');
  return configSchema.parse(JSON.parse(raw));
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function memoryContextFromJson(raw?: {
  enabled: boolean;
  dialog_tail: number;
  recall_k: number;
  max_tokens: number;
}): MemoryContextConfig {
  if (!raw) return DEFAULT_MEMORY_CONTEXT;
  return {
    enabled: raw.enabled,
    dialogTail: raw.dialog_tail,
    recallK: raw.recall_k,
    maxTokens: raw.max_tokens,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.data_dir, { recursive: true });
  mkdirSync(config.skills_dir, { recursive: true });
  const workspaceDir = config.sandbox?.workspace_dir ?? join(config.data_dir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
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
  applyMigration(queueDb, migrationSql('0005-queue.sql'), 5);
  applyMigration(queueDb, migrationSql('0008-queue.sql'), 8);
  applyMigration(queueDb, migrationSql('0009-queue.sql'), 9);
  applyMigration(queueDb, migrationSql('0010-queue.sql'), 10);
  applyMigration(queueDb, migrationSql('0011-queue.sql'), 11);
  applyMigration(queueDb, migrationSql('0012-queue.sql'), 12);
  applyMigration(queueDb, migrationSql('0013-queue.sql'), 13);
  applyMigration(queueDb, migrationSql('0014-queue.sql'), 14);
  applyMigration(memoryDb, migrationSql('0001-memory.sql'), 1);
  applyMigration(memoryDb, migrationSql('0002-memory.sql'), 2);
  applyMigration(memoryDb, migrationSql('0006-memory.sql'), 6);
  applyMigration(memoryDb, migrationSql('0007-memory.sql'), 7);
  applyMigration(memoryDb, migrationSql('0014-memory.sql'), 14);
  applyMigration(auditDb, migrationSql('0001-audit.sql'), 1);

  const queues = new QueueStore(queueDb);
  const audit = new AuditLog(auditDb);
  const llm = new OpenAiCompatClient(config.llm.p_llm);
  const qLlm = new OpenAiCompatClient(config.llm.q_llm);
  const quarantine = new QuarantineProcessor(qLlm, {
    maxTokens: config.llm.q_llm.max_tokens,
  });
  const channelState = new ChannelState(queueDb);
  const totpRef = config.gate?.second_factor?.totp_secret_ref;
  const totpSecret = totpRef !== undefined ? process.env[totpRef] : undefined;
  const pending = new PendingStore(queueDb);
  const reminders = new ReminderStore(queueDb);
  const workspace = new WorkspaceStore(workspaceDir);
  const episodes = new EpisodeStore(memoryDb);
  const webCache = new WebCacheStore(memoryDb);
  const knowledge = new KnowledgeStore(memoryDb);
  const promotion = new PromotionGate(memoryDb);
  const verifier = new KnowledgeVerifier(memoryDb, knowledge, { promotion });
  const snapshot = new MemorySnapshot(memoryDb, memoryPath, snapshotsDir);
  const curation = new CurationRunner(memoryDb, knowledge, promotion, snapshot);
  const consolidation = new ConsolidationRunner(knowledge, promotion, snapshot, qLlm, {
    batchSize: config.learning.consolidation_batch_size,
    maxTokens: config.llm.q_llm.max_tokens,
  });
  const skills = new SkillRegistry(config.skills_dir);
  const skillInstaller = new SkillInstaller({
    skillsDir: config.skills_dir,
    registry: skills,
    knowledge,
  });
  const sandbox = new DockerSandboxRunner({
    image: process.env.AEGIS_SANDBOX_IMAGE ?? 'alpine:3.20',
    internalNetwork: process.env.AEGIS_INTERNAL_NETWORK ?? 'aegis-internal',
    workspaceDir,
    runtime: config.sandbox?.runtime ?? 'docker',
  });
  const skillDryRun = new SkillDryRun({
    registry: skills,
    sandbox,
    promotion,
    knowledge,
  });
  const skillProposals = new SkillProposalRunner(memoryDb, episodes, config.learning, {
    skillsDir: config.skills_dir,
    threshold: config.learning.skill_proposal_threshold,
    windowDays: config.learning.skill_proposal_window_days,
    llm,
  });
  const skillMetrics = new SkillMetricsStore(memoryDb);
  const skillCurator = new SkillCurator(skillMetrics, skills, snapshot, {
    skillsDir: config.skills_dir,
    staleDays: config.learning.skill_curator_stale_days,
    minSuccessRate: config.learning.skill_curator_min_success_rate,
  });
  const webCfg = config.web ?? {
    max_response_kb: 512,
    cache_ttl_s: 3600,
    broker_host: 'aegis-broker:8080',
  };
  const webFetcher = new SandboxWebFetcher(sandbox, {
    brokerHost: webCfg.broker_host,
    maxResponseBytes: webCfg.max_response_kb * 1024,
    workspaceDir,
    ...(process.env.AEGIS_MEDIA_SANDBOX_IMAGE !== undefined
      ? { mediaImage: process.env.AEGIS_MEDIA_SANDBOX_IMAGE }
      : {}),
  });
  const mcpServers = loadMcpRegistry(config.mcp);
  const mcpNodeImage =
    process.env.AEGIS_MCP_SANDBOX_IMAGE ??
    'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';
  const mcpRunner =
    mcpServers.length > 0
      ? new DelegatingMcpRunner(
          new SandboxMcpRunner(sandbox, { image: mcpNodeImage }),
          new StdioMcpRunner(),
          new HttpMcpRunner(),
        )
      : undefined;
  const budget = config.budget
    ? new BudgetEngine(queueDb, {
        dailyTokenLimit: config.budget.daily_token_limit,
        reserveForOwner: config.budget.reserve_for_owner,
      })
    : undefined;
  const healthCfg = config.health ?? {
    enabled: true,
    host: '127.0.0.1' as const,
    port: 8791,
    stale_threshold_ms: 30_000,
    systemd_notify: true,
  };
  const healthState: HealthState = { startedAt: Date.now(), lastTickAt: null };
  const healthServer =
    healthCfg.enabled
      ? createHealthServer({
          host: healthCfg.host,
          port: healthCfg.port,
          state: healthState,
          staleThresholdMs: healthCfg.stale_threshold_ms,
        })
      : undefined;
  if (healthServer) {
    healthServer.listen(healthCfg.port, healthCfg.host);
  }

  const orchestrator = new Orchestrator(queues, audit, llm, pending, {
    episodes,
    knowledge,
    promotion,
    verifier,
    curation,
    consolidation,
    qLlm,
    qMaxTokens: config.llm.q_llm.max_tokens,
    quarantine,
    skills,
    skillInstaller,
    skillDryRun,
    skillProposals,
    skillMetrics,
    skillCurator,
    getReuseMetrics: () => computeReuseMetrics(memoryDb),
    getSkillReuseMetrics: () => computeSkillReuseMetrics(memoryDb),
    learning: config.learning,
    memoryContext: memoryContextFromJson(config.memory?.context),
    webFetcher,
    webCache,
    webCacheTtlS: webCfg.cache_ttl_s,
    ...(webCfg.search_url !== undefined ? { searchUrl: webCfg.search_url } : {}),
    reminders,
    workspace,
    mcpServers,
    ...(mcpRunner !== undefined ? { mcpRunner } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(config.budget?.notify_session_id !== undefined
      ? { ownerNotifySessionId: config.budget.notify_session_id }
      : {}),
    channelState,
    pairedChannels: () => ({
      telegram: channelState.getOwnerUserId() !== undefined,
      discord: channelState.getDiscordOwnerId() !== undefined,
      webchat: channelState.isWebchatPaired(),
      matrix: channelState.getMatrixOwnerUserId() !== undefined,
      slack: channelState.getSlackOwnerUserId() !== undefined,
    }),
    ...(config.gate?.second_factor !== undefined
      ? { secondFactor: config.gate.second_factor }
      : {}),
    ...(totpSecret !== undefined && totpSecret.length > 0 ? { totpSecret } : {}),
    ...(process.env.AEGIS_MEDIA_SANDBOX_IMAGE !== undefined
      ? {
          voiceSynthesizer: new SandboxVoiceSynthesizer({
            runner: sandbox,
            mediaImage: process.env.AEGIS_MEDIA_SANDBOX_IMAGE,
          }),
        }
      : {}),
    onLoopTick: () => {
      healthState.lastTickAt = Date.now();
      if (healthCfg.systemd_notify) sdNotifyWatchdog();
    },
  });
  const scheduleEntries: ScheduleEntry[] = config.schedules.map((s) => ({
    id: s.id,
    cron: s.cron,
    text: s.text,
    ...(s.session_id !== undefined ? { session_id: s.session_id } : {}),
  }));
  const scheduler =
    scheduleEntries.length > 0
      ? new ScheduleRunner(queues, queueDb, audit, {
          schedules: scheduleEntries,
          reminders,
        })
      : new ScheduleRunner(queues, queueDb, audit, { schedules: [], reminders });

  const tgClient = new TelegramClient(config.telegram.bot_token_ref, {
    pollTimeoutS: config.telegram.poll_timeout_s,
  });
  const adapter = new TelegramAdapter(
    tgClient,
    queues,
    audit,
    channelState,
    config.telegram.pairing_code_ref,
    {
      voiceTranscriber: new SandboxVoiceTranscriber({
        runner: sandbox,
        workspaceDir,
        ...(process.env.AEGIS_MEDIA_SANDBOX_IMAGE !== undefined
          ? { mediaImage: process.env.AEGIS_MEDIA_SANDBOX_IMAGE }
          : {}),
      }),
      workspaceDir,
    },
  );

  const discordAdapter = config.discord
    ? new DiscordAdapter(
        new LiveDiscordClient(config.discord.bot_token_ref),
        queues,
        audit,
        channelState,
        config.discord.pairing_code_ref,
      )
    : undefined;

  const emailPollMs = (config.email?.poll_interval_s ?? 60) * 1000;
  const emailFetcher = config.email?.imap_bridge_host
    ? new BrokerHttpEmailFetcher(config.email.imap_bridge_host)
    : new NullEmailFetcher();
  if (config.email && !config.email.imap_bridge_host) {
    console.warn('email: imap_bridge_host unset — no mail fetched (deploy/broker/imap-bridge/)');
  }
  const emailAdapter = config.email
    ? new EmailInputAdapter(emailFetcher, queues, audit, channelState, {
        sessionId: config.email.session_id,
        pollMs: emailPollMs,
      })
    : undefined;

  const webchatCfg = config.webchat;
  const webchatAdapter =
    webchatCfg?.enabled !== false && webchatCfg !== undefined
      ? new WebChatAdapter(queues, audit, channelState, webchatCfg.pairing_code_ref, {
          host: webchatCfg.host,
          port: webchatCfg.port,
          listSkills: () => skills.listForPrompt(),
          getHistory: (limit) =>
            episodesToHistoryMessages(episodes.tailBySession(WEBCHAT_DEFAULT_SESSION, limit)),
        })
      : undefined;

  const matrixAdapter = config.matrix
    ? new MatrixAdapter(
        new LiveMatrixClient(config.matrix.homeserver_ref, config.matrix.access_token_ref),
        queues,
        audit,
        channelState,
        config.matrix.pairing_code_ref,
      )
    : undefined;

  const slackAdapter = config.slack
    ? new SlackAdapter(
        new LiveSlackClient(config.slack.bot_token_ref, config.slack.app_token_ref),
        queues,
        audit,
        channelState,
        config.slack.pairing_code_ref,
      )
    : undefined;

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());

  audit.append({ actor: 'host', action: 'host.started', decision: 'info' });
  if (healthCfg.systemd_notify) sdNotifyReady();
  console.log(`aegis host started (data: ${config.data_dir}); orchestrator + adapters`);
  if (healthServer) {
    console.log(`health: http://${healthCfg.host}:${healthCfg.port}/health`);
  }

  const runners = [orchestrator.run(ac.signal), adapter.run(ac.signal), scheduler.run(ac.signal)];
  if (discordAdapter) runners.push(discordAdapter.run(ac.signal));
  if (emailAdapter) runners.push(emailAdapter.run(ac.signal));
  if (webchatAdapter) {
    runners.push(webchatAdapter.run(ac.signal));
    console.log(`webchat: http://${webchatCfg!.host}:${webchatCfg!.port}`);
  }
  if (matrixAdapter) runners.push(matrixAdapter.run(ac.signal));
  if (slackAdapter) runners.push(slackAdapter.run(ac.signal));
  await Promise.all(runners);

  audit.append({ actor: 'host', action: 'host.stopped', decision: 'info' });
  console.log('aegis host stopped');
}

main().catch((err: unknown) => {
  console.error('fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
