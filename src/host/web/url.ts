/**
 * Валидация URL для web.fetch — SSRF-защита в ядре (до sandbox/broker).
 */
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map((x) => Number(x));
  if (octets.some((n) => n > 255)) return true;
  const a = octets[0] ?? 256;
  const b = octets[1] ?? 0;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export function validateFetchUrl(raw: string): UrlValidation {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'only https URLs are allowed' };
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
    return { ok: false, reason: 'host blocked' };
  }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return { ok: false, reason: 'host blocked' };
  }
  if (isPrivateIpv4(host)) {
    return { ok: false, reason: 'private/reserved IP blocked' };
  }
  return { ok: true, url };
}
