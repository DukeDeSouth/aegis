/**
 * S5 (Sprint 35): loopback health endpoint for host liveness.
 */
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

export interface HealthState {
  startedAt: number;
  lastTickAt: number | null;
}

export interface HealthServerOptions {
  host: string;
  port: number;
  state: HealthState;
  staleThresholdMs: number;
}

export function createHealthServer(opts: HealthServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const now = Date.now();
    const last = opts.state.lastTickAt;
    const loopAlive = last !== null && now - last < opts.staleThresholdMs;
    const body = JSON.stringify({
      ok: loopAlive,
      loop_alive: loopAlive,
      last_tick_at: last,
      uptime_s: Math.floor((now - opts.state.startedAt) / 1000),
    });
    res.writeHead(loopAlive ? 200 : 503, { 'content-type': 'application/json' });
    res.end(body);
  });
  return server;
}

/** Best-effort systemd WATCHDOG=1 (no-op without NOTIFY_SOCKET). */
export function sdNotifyWatchdog(): void {
  const raw = process.env.NOTIFY_SOCKET;
  if (!raw) return;
  const path = raw.startsWith('@') ? `\0${raw.slice(1)}` : raw;
  const client = connect(path);
  client.on('error', () => {
    /* ignore */
  });
  client.write('WATCHDOG=1\n');
  client.end();
}

export function sdNotifyReady(): void {
  const raw = process.env.NOTIFY_SOCKET;
  if (!raw) return;
  const path = raw.startsWith('@') ? `\0${raw.slice(1)}` : raw;
  const client = connect(path);
  client.on('error', () => {
    /* ignore */
  });
  client.write('READY=1\n');
  client.end();
}
