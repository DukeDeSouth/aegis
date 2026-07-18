/**
 * HTTP-сервер дашборда (F11): GET / only, 127.0.0.1 default.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import type { DashboardConfig } from './config.ts';
import { collectDashboardData } from './queries.ts';
import { renderConnectorsPage, renderDashboard } from './render.ts';

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
} as const;

export function createDashboardServer(cfg: DashboardConfig): Server {
  return createHttpServer((req, res) => {
    void (async () => {
      const path = req.url?.split('?')[0] ?? '/';
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
        return;
      }
      try {
        const data = await collectDashboardData(cfg);
        if (path === '/connectors') {
          res.writeHead(200, SECURITY_HEADERS);
          res.end(renderConnectorsPage(data));
          return;
        }
        if (path !== '/') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, SECURITY_HEADERS);
        res.end(renderDashboard(data));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`dashboard error: ${msg}`);
      }
    })();
  });
}

export function startDashboard(cfg: DashboardConfig): Promise<Server> {
  const server = createDashboardServer(cfg);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve(server));
  });
}
