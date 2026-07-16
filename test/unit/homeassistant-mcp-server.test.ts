/**
 * Sprint 25 / C4: connectors/homeassistant/server/server.mjs
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../../src/mcp/stdio-transport.ts';

const SERVER = join(process.cwd(), 'connectors', 'homeassistant', 'server', 'server.mjs');

interface SeenRequest {
  method: string;
  url: string;
  host: string | undefined;
  authorization: string | undefined;
  body: string;
}

let broker: Server | undefined;
afterEach(() => {
  broker?.close();
  broker = undefined;
});

function startFakeBroker(
  respond: (req: IncomingMessage, body: string) => { status: number; json: unknown },
): Promise<{ port: number; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  return new Promise((resolve) => {
    broker = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          host: req.headers.host,
          authorization: req.headers.authorization,
          body,
        });
        const { status, json } = respond(req, body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    broker.listen(0, '127.0.0.1', () => {
      resolve({ port: (broker!.address() as { port: number }).port, seen });
    });
  });
}

function client(port: number): StdioMcpClient {
  return new StdioMcpClient({
    command: ['node', SERVER, `127.0.0.1:${port}`],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    timeoutMs: 10_000,
  });
}

describe('homeassistant MCP server (C4)', () => {
  it('states_list: Host homeassistant.local, выжимка, БЕЗ Authorization', async () => {
    const { port, seen } = await startFakeBroker(() => ({
      status: 200,
      json: [
        { entity_id: 'light.kitchen', state: 'on', attributes: {} },
        { entity_id: 'sensor.temp', state: '21.5', attributes: { unit_of_measurement: '°C' } },
      ],
    }));
    const result = await client(port).callTool('states_list', {});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('light.kitchen: on');
    expect(result.content).toContain('sensor.temp: 21.5 °C');
    expect(seen[0]!.host).toBe('homeassistant.local');
    expect(seen[0]!.url).toBe('/api/states');
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('lock_unlock: POST services/lock/unlock', async () => {
    const { port, seen } = await startFakeBroker(() => ({ status: 200, json: [] }));
    const result = await client(port).callTool('lock_unlock', { entity_id: 'lock.front' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('lock.front');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/api/services/lock/unlock');
    expect(JSON.parse(seen[0]!.body)).toEqual({ entity_id: 'lock.front' });
  });

  it('climate_set_temperature: требует temperature', async () => {
    const { port, seen } = await startFakeBroker(() => ({ status: 200, json: [] }));
    const missing = await client(port).callTool('climate_set_temperature', {
      entity_id: 'climate.living',
    });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('temperature');
    expect(seen.length).toBe(0);

    const ok = await client(port).callTool('climate_set_temperature', {
      entity_id: 'climate.living',
      temperature: 22,
    });
    expect(ok.isError).toBe(false);
    expect(seen[0]!.url).toBe('/api/services/climate/set_temperature');
  });

  it('401 → подсказка про ha token', async () => {
    const { port } = await startFakeBroker(() => ({ status: 401, json: {} }));
    const result = await client(port).callTool('states_list', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ha token');
  });
});
