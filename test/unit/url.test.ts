import { describe, expect, it } from 'vitest';
import { validateFetchUrl } from '../../src/host/web/url.ts';

describe('validateFetchUrl (SSRF)', () => {
  it('принимает публичный https URL', () => {
    const r = validateFetchUrl('https://example.com/article');
    expect(r.ok).toBe(true);
  });

  it('отклоняет http', () => {
    const r = validateFetchUrl('http://example.com/');
    expect(r.ok).toBe(false);
  });

  it('блокирует localhost', () => {
    expect(validateFetchUrl('https://localhost/').ok).toBe(false);
  });

  it('блокирует metadata IP 169.254.169.254', () => {
    expect(validateFetchUrl('https://169.254.169.254/').ok).toBe(false);
  });

  it('блокирует 127.0.0.1', () => {
    expect(validateFetchUrl('https://127.0.0.1/').ok).toBe(false);
  });

  it('блокирует 10.x private', () => {
    expect(validateFetchUrl('https://10.0.0.5/internal').ok).toBe(false);
  });
});
