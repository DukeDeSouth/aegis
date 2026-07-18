/**
 * U4 (Sprint 34): GET /connectors read-only page.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DashboardConfig } from '../src/config.ts';
import { collectDashboardData } from '../src/queries.ts';
import { createDashboardServer } from '../src/server.ts';
import { AuditLog } from '../../../src/host/audit/log.ts';
import { applyMigration, openDb } from '../../../src/memory/db.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aegis-dash-conn-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function migration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
}

function seedWithMcp(): DashboardConfig {
  const root = join(tmp, randomUUID());
  const dataDir = join(root, 'data');
  const skillsDir = join(root, 'skills');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  const configPath = join(root, 'aegis.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      data_dir: dataDir,
      skills_dir: skillsDir,
      mcp: {
        servers: [
          { name: 'medialibrary', transport: 'stdio', tools: [{ name: 'radarr_queue_list' }] },
        ],
      },
    }),
  );

  const now = 1_750_000_000_000;
  const queueDb = openDb(join(dataDir, 'queue.db'));
  const auditDb = openDb(join(dataDir, 'audit.db'));
  applyMigration(queueDb, migration('0001-queue.sql'), 1);
  applyMigration(queueDb, migration('0003-queue.sql'), 3);
  applyMigration(queueDb, migration('0004-budget.sql'), 4);
  applyMigration(queueDb, migration('0009-queue.sql'), 9);
  applyMigration(auditDb, migration('0001-audit.sql'), 1);
  const audit = new AuditLog(auditDb, { now: () => now });
  audit.append({
    actor: 'orch',
    action: 'mcp.tool.medialibrary',
    decision: 'info',
    payload: { tool: 'radarr_queue_list' },
  });
  queueDb.close();
  auditDb.close();

  return {
    dataDir,
    skillsDir,
    configPath,
    mcpServers: [{ name: 'medialibrary', transport: 'stdio', toolCount: 1 }],
    healthUrl: 'http://127.0.0.1:1/health',
    host: '127.0.0.1',
    port: 0,
    budgetLimit: 100_000,
    budgetReserve: 20_000,
  };
}

describe('dashboard connectors (U4)', () => {
  it('collectDashboardData includes per-server MCP stats', async () => {
    const cfg = seedWithMcp();
    const data = await collectDashboardData(cfg, 1_750_000_000_000);
    expect(data.mcpServers).toHaveLength(1);
    expect(data.connectorStats[0]?.server).toBe('medialibrary');
    expect(data.connectorStats[0]?.callCount).toBe(1);
  });

  it('GET /connectors returns 200 read-only HTML', async () => {
    const cfg = seedWithMcp();
    const server = createDashboardServer({ ...cfg, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/connectors`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('medialibrary');
    expect(body).toContain('MCP connectors');

    const post = await fetch(`http://127.0.0.1:${port}/connectors`, { method: 'POST' });
    expect(post.status).toBe(405);

    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
});
