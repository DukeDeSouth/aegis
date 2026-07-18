/**
 * WebChat session cookie (HttpOnly, SameSite=Strict).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const WEBCHAT_COOKIE = 'aegis_webchat_session';

export function generateSessionToken(): string {
  return randomBytes(24).toString('hex');
}

export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === WEBCHAT_COOKIE) {
      const value = rest.join('=');
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

export function formatSetCookie(token: string): string {
  return `${WEBCHAT_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function sessionMatches(cookie: string | undefined, expected: string | undefined): boolean {
  if (cookie === undefined || expected === undefined) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
