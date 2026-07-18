/**
 * Dashboard config: paths from aegis.config.json (F11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface McpServerSummary {
  name: string;
  transport: string;
  toolCount: number;
}

export interface ConnectorAuditStat {
  server: string;
  lastCallAt: number | null;
  lastTool: string | null;
  callCount: number;
}

export interface DashboardConfig {
  dataDir: string;
  skillsDir: string;
  configPath: string;
  mcpServers: McpServerSummary[];
  healthUrl: string;
  host: string;
  port: number;
  budgetLimit: number;
  budgetReserve: number;
}

interface RawMcpServer {
  name?: string;
  transport?: string;
  tools?: unknown[];
}

interface RawConfig {
  data_dir?: string;
  skills_dir?: string;
  mcp?: { servers?: RawMcpServer[] };
  budget?: { daily_token_limit?: number; reserve_for_owner?: number };
  health?: { host?: string; port?: number };
}

function parseMcpServers(raw: RawConfig): McpServerSummary[] {
  const servers = raw.mcp?.servers ?? [];
  return servers
    .filter((s): s is RawMcpServer & { name: string } => typeof s.name === 'string')
    .map((s) => ({
      name: s.name,
      transport: typeof s.transport === 'string' ? s.transport : '?',
      toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadDashboardConfig(): DashboardConfig {
  const configPath = process.env.AEGIS_CONFIG ?? './aegis.config.json';
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RawConfig;
  const host = process.env.AEGIS_DASHBOARD_HOST ?? '127.0.0.1';
  const port = Number(process.env.AEGIS_DASHBOARD_PORT ?? '8787');
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('invalid AEGIS_DASHBOARD_PORT');
  }
  const healthPort = Number(process.env.AEGIS_HEALTH_PORT ?? raw.health?.port ?? '8791');
  const healthHost = raw.health?.host ?? '127.0.0.1';
  return {
    dataDir: raw.data_dir ?? './data',
    skillsDir: raw.skills_dir ?? './skills',
    configPath,
    mcpServers: parseMcpServers(raw),
    healthUrl: `http://${healthHost}:${healthPort}/health`,
    host,
    port,
    budgetLimit: raw.budget?.daily_token_limit ?? 100_000,
    budgetReserve: raw.budget?.reserve_for_owner ?? 20_000,
  };
}

export function dbPaths(cfg: DashboardConfig): {
  queue: string;
  memory: string;
  audit: string;
} {
  return {
    queue: join(cfg.dataDir, 'queue.db'),
    memory: join(cfg.dataDir, 'memory.db'),
    audit: join(cfg.dataDir, 'audit.db'),
  };
}
