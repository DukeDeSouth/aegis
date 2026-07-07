import { describe, expect, it } from 'vitest';
import { nextFireAtUtc, parseRemindCommand } from '../../src/host/scheduler/reminders.ts';

describe('parseRemindCommand', () => {
  it('parses valid remind command', () => {
    const r = parseRemindCommand('/remind 19:00 call mom');
    expect(r).toEqual({ ok: true, hour: 19, minute: 0, message: 'call mom' });
  });

  it('rejects invalid time', () => {
    expect(parseRemindCommand('/remind 25:00 x').ok).toBe(false);
  });
});

describe('nextFireAtUtc', () => {
  it('rolls to tomorrow when time passed', () => {
    const now = new Date('2026-07-06T20:00:00.000Z');
    const fire = nextFireAtUtc(19, 0, now);
    expect(new Date(fire).toISOString()).toBe('2026-07-07T19:00:00.000Z');
  });
});
