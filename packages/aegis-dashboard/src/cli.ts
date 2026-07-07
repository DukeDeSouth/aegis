/**
 * CLI: aegis-dashboard (F11).
 */
import { loadDashboardConfig } from './config.ts';
import { startDashboard } from './server.ts';

const cfg = loadDashboardConfig();
const server = await startDashboard(cfg);
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
console.log(`aegis-dashboard listening on http://${cfg.host}:${port}/ (read-only)`);

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
