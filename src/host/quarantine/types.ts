/**
 * Контракты карантин-плоскости (ADR-0005, Sprint 7).
 */
import { z } from 'zod';

export const QUARANTINE_SOURCES = ['forwarded', 'attachment', 'web', 'mcp', 'email'] as const;
export type QuarantineSource = (typeof QUARANTINE_SOURCES)[number];

export const quarantineContentSchema = z
  .object({
    kind: z.literal('quarantine_content'),
    source: z.enum(QUARANTINE_SOURCES),
    body: z.string().min(1),
    session_id: z.string().min(1),
  })
  .strict();

export type QuarantineContentPayload = z.infer<typeof quarantineContentSchema>;
