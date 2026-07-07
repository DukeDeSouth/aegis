/**
 * Схема конфигурации (ADR-0008): два LLM-профиля.
 * key_ref — ссылка на секрет (имя переменной окружения), не значение:
 * .strict() отклоняет любые лишние поля, включая попытку положить ключ в конфиг.
 */
import { z } from 'zod';

/** Ссылка на секрет: имя переменной окружения, не значение. */
const keyRef = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'ref is an env var name, not a secret');

export const llmProfileSchema = z
  .object({
    base_url: z.string().url(),
    model: z.string().min(1),
    key_ref: keyRef,
    max_tokens: z.number().int().positive(),
  })
  .strict();

export const telegramSchema = z
  .object({
    bot_token_ref: keyRef,
    pairing_code_ref: keyRef,
    /** Long polling timeout getUpdates, секунды. */
    poll_timeout_s: z.number().int().min(0).max(50).default(30),
  })
  .strict();

export const discordSchema = z
  .object({
    bot_token_ref: keyRef,
    pairing_code_ref: keyRef,
  })
  .strict();

export const emailInputSchema = z
  .object({
    poll_interval_s: z.number().int().min(5).default(60),
    session_id: z.string().min(1).default('email:inbox'),
  })
  .strict();

export const scheduleSchema = z
  .object({
    id: z.string().min(1),
    cron: z.string().min(1),
    text: z.string().min(1),
    session_id: z.string().min(1).optional(),
  })
  .strict();

export const budgetSchema = z
  .object({
    daily_token_limit: z.number().int().positive(),
    reserve_for_owner: z.number().int().nonnegative().default(0),
    /** Сессия владельца для уведомлений о деградации (например tg:12345). */
    notify_session_id: z.string().min(1),
  })
  .strict();

export const learningSchema = z
  .object({
    /** LLM-рефлексия / фоновое self-improvement (MVP: false). */
    self_improvement_llm_enabled: z.boolean().default(false),
    /** Минимальный reuse_rate для scheduler LLM-задач (0 = не проверять). */
    min_reuse_rate: z.number().min(0).max(1).default(0),
    /** F5: повторов задачи для предложения draft-навыка. */
    skill_proposal_threshold: z.number().int().min(2).default(3),
    skill_proposal_window_days: z.number().int().min(1).default(14),
    /** F6: дней без использования → кандидат на архив. */
    skill_curator_stale_days: z.number().int().min(1).default(30),
    skill_curator_min_success_rate: z.number().min(0).max(1).default(0.5),
  })
  .strict();

export const memoryContextSchema = z
  .object({
    enabled: z.boolean().default(true),
    dialog_tail: z.number().int().min(0).max(50).default(10),
    recall_k: z.number().int().min(0).max(20).default(3),
    max_tokens: z.number().int().min(256).max(8192).default(2048),
  })
  .strict();

export const memorySchema = z
  .object({
    context: memoryContextSchema.default({
      enabled: true,
      dialog_tail: 10,
      recall_k: 3,
      max_tokens: 2048,
    }),
  })
  .strict();

export const webSchema = z
  .object({
    max_response_kb: z.number().int().positive().default(512),
    cache_ttl_s: z.number().int().positive().default(3600),
    broker_host: z.string().min(1).default('aegis-broker:8080'),
    /** C2: шаблон поиска с {query}; /research = /fetch этого URL. */
    search_url: z.string().url().includes('{query}').optional(),
  })
  .strict();

export const sandboxSchema = z
  .object({
    /** Выделенная rw-директория workspace (F4); по умолчанию data_dir/workspace. */
    workspace_dir: z.string().min(1).optional(),
  })
  .strict();

const actionClassSchema = z.enum(['read-only', 'reversible', 'irreversible']);

export const mcpToolSchema = z
  .object({
    name: z.string().min(1),
    action_class: actionClassSchema,
  })
  .strict();

const mcpServerName = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

const mcpStdioServerSchema = z
  .object({
    name: mcpServerName,
    transport: z.literal('stdio'),
    command: z.array(z.string().min(1)).min(1),
    /** Host-путь к MCP-серверу; монтируется в sandbox как /mcp-server (F8). */
    server_dir: z.string().min(1).optional(),
    tools: z.array(mcpToolSchema).min(1),
    allowed_hosts: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * P-A (Sprint 22): HTTP MCP через broker. Ядро шлёт POST на broker_host с
 * `Host: host`; Authorization инжектит Envoy. Полей для токена нет по
 * построению (strict) — V2 распространяется на HTTP MCP.
 */
const mcpHttpServerSchema = z
  .object({
    name: mcpServerName,
    transport: z.literal('http'),
    broker_host: z.string().min(1),
    host: z.string().min(1),
    path: z.string().startsWith('/').optional(),
    tools: z.array(mcpToolSchema).min(1),
  })
  .strict();

export const mcpServerSchema = z.discriminatedUnion('transport', [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
]);

export const mcpSchema = z
  .object({
    servers: z.array(mcpServerSchema).default([]),
  })
  .strict();

export const configSchema = z
  .object({
    /** Директория файлов БД (queue.db, memory.db, audit.db). */
    data_dir: z.string().min(1).default('./data'),
    /** Директория навыков (SKILL.md + manifest.json), Sprint 8. */
    skills_dir: z.string().min(1).default('./skills'),
    budget: budgetSchema.optional(),
    schedules: z.array(scheduleSchema).default([]),
    learning: learningSchema.default({
      self_improvement_llm_enabled: false,
      min_reuse_rate: 0,
      skill_proposal_threshold: 3,
      skill_proposal_window_days: 14,
      skill_curator_stale_days: 30,
      skill_curator_min_success_rate: 0.5,
    }),
    memory: memorySchema.optional(),
    web: webSchema.optional(),
    sandbox: sandboxSchema.optional(),
    mcp: mcpSchema.optional(),
    llm: z
      .object({
        p_llm: llmProfileSchema,
        q_llm: llmProfileSchema,
      })
      .strict(),
    telegram: telegramSchema,
    discord: discordSchema.optional(),
    email: emailInputSchema.optional(),
  })
  .strict();

export type AegisConfig = z.infer<typeof configSchema>;
export type LlmProfile = z.infer<typeof llmProfileSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type DiscordConfig = z.infer<typeof discordSchema>;
export type EmailInputConfig = z.infer<typeof emailInputSchema>;
export type BudgetConfig = z.infer<typeof budgetSchema>;
export type ScheduleConfig = z.infer<typeof scheduleSchema>;
export type LearningConfig = z.infer<typeof learningSchema>;
export type MemoryContextConfigJson = z.infer<typeof memoryContextSchema>;
export type MemoryConfig = z.infer<typeof memorySchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpStdioServerConfig = z.infer<typeof mcpStdioServerSchema>;
export type McpHttpServerConfig = z.infer<typeof mcpHttpServerSchema>;
