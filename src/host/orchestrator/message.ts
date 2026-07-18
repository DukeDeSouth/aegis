/**
 * Контракт payload сообщения во входной очереди (Sprint 1–7).
 * Sprint 4: union с approved_action для human-gate.
 * Sprint 7: quarantine_content для недоверенного входа.
 */
import { z } from 'zod';
import { quarantineContentSchema } from '../quarantine/types.ts';

const userTextSchema = z
  .object({
    text: z.string().min(1),
    session_id: z.string().min(1),
  })
  .strict();

const approvedActionSchema = z
  .object({
    kind: z.literal('approved_action'),
    token: z.string().min(1),
    session_id: z.string().min(1),
    totp_code: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

export const inboundPayloadSchema = z.union([
  userTextSchema,
  approvedActionSchema,
  quarantineContentSchema,
]);

export type InboundPayload = z.infer<typeof inboundPayloadSchema>;
export type UserTextPayload = z.infer<typeof userTextSchema>;
export type ApprovedActionPayload = z.infer<typeof approvedActionSchema>;
export type { QuarantineContentPayload } from '../quarantine/types.ts';

export function isQuarantineContent(
  p: InboundPayload,
): p is z.infer<typeof quarantineContentSchema> {
  return 'kind' in p && p.kind === 'quarantine_content';
}

export function isApprovedAction(p: InboundPayload): p is ApprovedActionPayload {
  return 'kind' in p && p.kind === 'approved_action';
}

export function isUserText(p: InboundPayload): p is UserTextPayload {
  return 'text' in p;
}

/** Безопасный парс JSON-строки payload; null — некорректный JSON или несоответствие схеме. */
export function parseInboundPayload(raw: string): InboundPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = inboundPayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const outboundPayloadSchema = z
  .object({
    text: z.string().min(1),
    session_id: z.string().min(1),
    voice_rel_path: z.string().min(1).optional(),
  })
  .strict();

export type OutboundPayload = z.infer<typeof outboundPayloadSchema>;

export function parseOutboundPayload(raw: string): OutboundPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = outboundPayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
