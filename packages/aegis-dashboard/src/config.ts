/**
 * Dashboard config: paths from aegis.config.json (F11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DashboardConfig {
  dataDir: string;
  skillsDir: string;
  host: string;
  port: number;
  budgetLimit: number;
  budgetReserve: number;
}

interface RawConfig {
  data_dir?: string;
  skills_dir?: string;
  budget?: { daily_token_limit?: number; reserve_for_owner?: number };
}

export function loadDashboardConfig(): DashboardConfig {
  const configPath = process.env.AEGIS_CONFIG ?? './aegis.config.json';
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RawConfig;
  const host = process.env.AEGIS_DASHBOARD_HOST ?? '127.0.0.1';
  const port = Number(process.env.AEGIS_DASHBOARD_PORT ?? '8787');
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('invalid AEGIS_DASHBOARD_PORT');
  }
  return {
    dataDir: raw.data_dir ?? './data',
    skillsDir: raw.skills_dir ?? './skills',
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
