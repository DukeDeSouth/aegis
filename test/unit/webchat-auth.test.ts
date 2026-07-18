import { describe, expect, it } from 'vitest';
import {
  formatSetCookie,
  parseSessionCookie,
  sessionMatches,
} from '../../src/host/adapter/webchat/auth.ts';

describe('webchat auth', () => {
  it('parseSessionCookie', () => {
    expect(parseSessionCookie('a=1; aegis_webchat_session=abc123; b=2')).toBe('abc123');
    expect(parseSessionCookie(undefined)).toBeUndefined();
  });

  it('formatSetCookie HttpOnly', () => {
    expect(formatSetCookie('tok')).toContain('HttpOnly');
    expect(formatSetCookie('tok')).toContain('SameSite=Strict');
  });

  it('sessionMatches timing-safe', () => {
    expect(sessionMatches('abc', 'abc')).toBe(true);
    expect(sessionMatches('abc', 'abd')).toBe(false);
    expect(sessionMatches(undefined, 'abc')).toBe(false);
  });
});
