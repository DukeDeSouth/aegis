import { describe, expect, it } from 'vitest';
import { fireKey, isDue, parseCron } from '../../src/host/scheduler/cron.ts';

describe('cron parser', () => {
  it('парсит HH:MM daily', () => {
    const spec = parseCron('07:30');
    expect(spec).toEqual({ kind: 'daily', hour: 7, minute: 30 });
    const now = new Date(Date.UTC(2026, 6, 6, 7, 30, 0));
    expect(isDue(spec, now)).toBe(true);
    expect(fireKey(spec, now)).toContain('07:30');
  });

  it('парсит */N interval', () => {
    const spec = parseCron('*/15');
    expect(spec).toEqual({ kind: 'interval', everyMinutes: 15 });
    const now = new Date(1_750_000_000_000);
    expect(isDue(spec, now)).toBe(Math.floor(now.getTime() / 60_000) % 15 === 0);
  });

  it('отклоняет неизвестный формат', () => {
    expect(() => parseCron('every morning')).toThrow();
  });
});
