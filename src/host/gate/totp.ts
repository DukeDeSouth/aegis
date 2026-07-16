import { createHmac, timingSafeEqual } from 'node:crypto';

function hotp(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const o = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[o]! & 0x7f) << 24) |
    ((hmac[o + 1]! & 0xff) << 16) |
    ((hmac[o + 2]! & 0xff) << 8) |
    (hmac[o + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

export function verifyTotp(code: string, secretHex: string, now = Date.now(), step = 30): boolean {
  if (!/^\d{6}$/.test(code) || secretHex.length < 20) return false;
  const secret = Buffer.from(secretHex, 'hex');
  if (secret.length < 10) return false;
  const ctr = BigInt(Math.floor(now / 1000 / step));
  for (const d of [-1n, 0n, 1n] as const) {
    const expected = hotp(secret, ctr + d);
    if (expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return true;
    }
  }
  return false;
}

export function totpCode(secretHex: string, now = Date.now(), step = 30): string {
  const secret = Buffer.from(secretHex, 'hex');
  const ctr = BigInt(Math.floor(now / 1000 / step));
  return hotp(secret, ctr);
}
