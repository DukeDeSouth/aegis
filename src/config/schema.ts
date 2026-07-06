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
    }),
    llm: z
      .object({
        p_llm: llmProfileSchema,
        q_llm: llmProfileSchema,
      })
      .strict(),
    telegram: telegramSchema,
  })
  .strict();

export type AegisConfig = z.infer<typeof configSchema>;
export type LlmProfile = z.infer<typeof llmProfileSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type BudgetConfig = z.infer<typeof budgetSchema>;
export type ScheduleConfig = z.infer<typeof scheduleSchema>;
export type LearningConfig = z.infer<typeof learningSchema>;
