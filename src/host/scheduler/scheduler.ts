/**
 * Scheduler: cron → inbound queue с provenance=scheduler (Sprint 9).
 */
import type Database from 'better-sqlite3';
import type { AuditLog } from '../audit/log.ts';
import type { QueueStore } from '../queue/store.ts';
import { fireKey, isDue, parseCron, type CronSpec } from './cron.ts';
import type { ScheduleEntry } from './types.ts';

export interface ScheduleRunnerOptions {
  schedules: ScheduleEntry[];
  tickMs?: number;
  now?: () => number;
}

interface ParsedSchedule {
  entry: ScheduleEntry;
  spec: CronSpec;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export class ScheduleRunner {
  private readonly queues: QueueStore;
  private readonly db: Database.Database;
  private readonly audit: AuditLog;
  private readonly schedules: ParsedSchedule[];
  private readonly tickMs: number;
  private readonly now: () => number;

  constructor(
    queues: QueueStore,
    db: Database.Database,
    audit: AuditLog,
    opts: ScheduleRunnerOptions,
  ) {
    this.queues = queues;
    this.db = db;
    this.audit = audit;
    this.schedules = opts.schedules.map((entry) => ({
      entry,
      spec: parseCron(entry.cron),
    }));
    this.tickMs = opts.tickMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  tick(): void {
    const nowDate = new Date(this.now());
    for (const { entry, spec } of this.schedules) {
      if (!isDue(spec, nowDate)) continue;
      const key = fireKey(spec, nowDate);
      const existing = this.db
        .prepare(`SELECT 1 FROM scheduler_fired WHERE schedule_id = ? AND fire_key = ?`)
        .get(entry.id, key);
      if (existing) continue;

      const sessionId = entry.session_id ?? `scheduler:${entry.id}`;
      this.queues.publish(
        'inbound',
        JSON.stringify({ text: entry.text, session_id: sessionId }),
        'scheduler',
      );
      this.db
        .prepare(`INSERT INTO scheduler_fired (schedule_id, fire_key, fired_at) VALUES (?, ?, ?)`)
        .run(entry.id, key, this.now());

      this.audit.append({
        actor: 'scheduler',
        action: 'scheduler.fired',
        decision: 'info',
        payload: { scheduleId: entry.id, fireKey: key, sessionId },
      });
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.tick();
      await sleep(this.tickMs, signal);
    }
  }
}
