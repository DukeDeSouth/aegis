import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/escape.ts';

describe('escapeHtml', () => {
  it('escapes XSS vectors', () => {
    const raw = '<script>alert("xss")</script>';
    const out = escapeHtml(raw);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
});
