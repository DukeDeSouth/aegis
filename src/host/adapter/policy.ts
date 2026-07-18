/**
 * Политика входа канала: deny-by-default авторизация + провенанс (docs/SECURITY_MODEL.md).
 * Чистая stateless-функция: не принимает решений о доступе (это делает обработчик,
 * знающий состояние pairing'а) — только классифицирует форму update.
 * Ветка по умолчанию — stranger (тихий deny): позитивное разрешение требует
 * строгого числового равенства from.id === ownerUserId.
 * До Sprint 7 (Quarantine) untrusted-контент отклоняется fail-closed (DISCOVERY F1);
 * в S7 эта ветка — маршрут в очередь с provenance 'quarantine'.
 */
import type { TgMessage, TgUpdate, TgVoice } from './telegram-client.ts';

export type Classified =
  | { kind: 'owner_text'; chatId: number; text: string }
  | { kind: 'owner_voice'; chatId: number; voice: TgVoice }
  | { kind: 'pair_attempt'; chatId: number; fromId: number; code: string }
  | { kind: 'approve_attempt'; chatId: number; token: string; totpCode?: string }
  | { kind: 'untrusted'; chatId: number; reason: 'forwarded' | 'non_text' }
  | { kind: 'stranger' }
  | { kind: 'ignored' };

const PAIR_RE = /^\/pair\s+(\S+)$/;
const APPROVE_RE = /^\/approve\s+(\S+)(?:\s+(\d{6}))?$/;

/** Извлекает текст недоверенного сообщения для Q-LLM (forward / вложение). */
export function extractUntrustedBody(msg: TgMessage): string {
  if (msg.forward_origin !== undefined) {
    const text = msg.text?.trim();
    return text && text.length > 0 ? text : '[forwarded message without text]';
  }
  const caption = msg.caption?.trim();
  if (caption && caption.length > 0) return caption;
  return '[non-text attachment]';
}

export function classifyUpdate(u: TgUpdate, ownerUserId: number | undefined): Classified {
  const msg = u.message;
  const fromId = msg?.from?.id;
  const chatId = msg?.chat?.id;
  if (!msg || typeof fromId !== 'number' || typeof chatId !== 'number') {
    return { kind: 'ignored' };
  }

  const pairMatch = typeof msg.text === 'string' ? PAIR_RE.exec(msg.text) : null;
  const pairCode = pairMatch?.[1];
  if (pairCode !== undefined) return { kind: 'pair_attempt', chatId, fromId, code: pairCode };

  if (ownerUserId !== undefined && fromId === ownerUserId) {
    const approveMatch = typeof msg.text === 'string' ? APPROVE_RE.exec(msg.text) : null;
    const token = approveMatch?.[1];
    const totpCode = approveMatch?.[2];
    if (token !== undefined) {
      return { kind: 'approve_attempt', chatId, token, ...(totpCode ? { totpCode } : {}) };
    }
  }

  if (ownerUserId === undefined || fromId !== ownerUserId) return { kind: 'stranger' };

  if (msg.forward_origin !== undefined) return { kind: 'untrusted', chatId, reason: 'forwarded' };
  if (msg.voice !== undefined) return { kind: 'owner_voice', chatId, voice: msg.voice };
  if (typeof msg.text !== 'string' || msg.text.length === 0) {
    return { kind: 'untrusted', chatId, reason: 'non_text' };
  }

  return { kind: 'owner_text', chatId, text: msg.text };
}
