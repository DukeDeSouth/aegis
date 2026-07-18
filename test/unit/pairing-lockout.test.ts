import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChannelState } from '../../src/host/adapter/state.ts';
import {
  PAIR_BACKOFF_BASE_MS,
  PAIR_BACKOFF_MAX_MS,
  pairingBackoffMs,
  recordPairingFailure,
} from '../../src/host/adapter/webchat/pairing-lockout.ts';
import { AuditLog } from '../../src/host/audit/log.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-pair-lock-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('pairing lockout (Sprint 41)', () => {
  it('backoff grows exponentially up to 15m', () => {
    expect(pairingBackoffMs(1)).toBe(PAIR_BACKOFF_BASE_MS);
    expect(pairingBackoffMs(2)).toBe(PAIR_BACKOFF_BASE_MS * 2);
    expect(pairingBackoffMs(10)).toBe(PAIR_BACKOFF_MAX_MS);
  });

  it('5 failures trigger lockout with audit', () => {
    const queueDb = openDb(join(tmp, 'pl-q.db'));
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(queueDb, migration('0002-queue.sql'), 2);
    applyMigration(queueDb, migration('0010-queue.sql'), 10);
    applyMigration(queueDb, migration('0014-queue.sql'), 14);
    const auditDb = openDb(join(tmp, 'pl-a.db'));
    applyMigration(auditDb, migration('0001-audit.sql'), 1);
    const state = new ChannelState(queueDb);
    const audit = new AuditLog(auditDb);
    const now = 1_750_000_000_000;

    for (let i = 0; i < 4; i++) {
      expect(recordPairingFailure(state, audit, 'test', now)).toBe(false);
    }
    expect(recordPairingFailure(state, audit, 'test', now)).toBe(true);
    expect(state.getWebchatPairLockoutUntil()).toBe(now + PAIR_BACKOFF_BASE_MS);
    expect(state.getWebchatPairFailCount()).toBe(0);

    const row = auditDb
      .prepare(`SELECT action FROM audit_log WHERE action = 'pairing.lockout'`)
      .get() as { action: string };
    expect(row.action).toBe('pairing.lockout');
  });
});
