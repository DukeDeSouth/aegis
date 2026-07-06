/**
 * Минимальный cron-парсер без npm: `HH:MM` (UTC daily) или `*\/N` (каждые N минут).
 */
export type CronSpec =
  { kind: 'daily'; hour: number; minute: number } | { kind: 'interval'; everyMinutes: number };

const DAILY_RE = /^(\d{1,2}):(\d{2})$/;
const INTERVAL_RE = /^\*\/(\d+)$/;

export function parseCron(expr: string): CronSpec {
  const trimmed = expr.trim();
  const daily = DAILY_RE.exec(trimmed);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`invalid daily cron: ${expr}`);
    }
    return { kind: 'daily', hour, minute };
  }
  const interval = INTERVAL_RE.exec(trimmed);
  if (interval) {
    const everyMinutes = Number(interval[1]);
    if (everyMinutes < 1 || everyMinutes > 24 * 60) {
      throw new Error(`invalid interval cron: ${expr}`);
    }
    return { kind: 'interval', everyMinutes };
  }
  throw new Error(`unsupported cron expression: ${expr}`);
}

/** Ключ идемпотентности для scheduler_fired. */
export function fireKey(spec: CronSpec, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const day = `${y}-${m}-${d}`;
  if (spec.kind === 'daily') {
    return `${day}@${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
  }
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  return `${day}:m${minuteBucket}`;
}

export function isDue(spec: CronSpec, now: Date): boolean {
  if (spec.kind === 'daily') {
    return now.getUTCHours() === spec.hour && now.getUTCMinutes() === spec.minute;
  }
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  return minuteBucket % spec.everyMinutes === 0;
}
