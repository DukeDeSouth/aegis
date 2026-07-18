import { afterAll, describe, expect, it } from 'vitest';
import { createHealthServer, type HealthState } from '../../src/host/health.ts';
import type { Server } from 'node:http';

describe('host health (S5)', () => {
  let server: Server;
  const state: HealthState = { startedAt: Date.now(), lastTickAt: Date.now() };

  afterAll(() => {
    server?.close();
  });

  it('GET /health returns 200 when loop is alive', async () => {
    server = createHealthServer({
      host: '127.0.0.1',
      port: 0,
      state,
      staleThresholdMs: 30_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; loop_alive: boolean };
    expect(body.ok).toBe(true);
    expect(body.loop_alive).toBe(true);
  });

  it('returns 503 when loop is stale', async () => {
    state.lastTickAt = Date.now() - 60_000;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { loop_alive: boolean };
    expect(body.loop_alive).toBe(false);
  });
});
