import { describe, expect, it } from 'vitest';
import { totpCode, verifyTotp } from '../../src/host/gate/totp.ts';

const SECRET = '0123456789abcdef0123456789abcdef';

describe('totp', () => {
  it('verify accepts current code', () => {
    const now = 1_750_000_000_000;
    const code = totpCode(SECRET, now);
    expect(verifyTotp(code, SECRET, now)).toBe(true);
    expect(verifyTotp('000000', SECRET, now)).toBe(false);
  });
});
