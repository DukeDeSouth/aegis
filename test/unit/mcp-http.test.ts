/**
 * P-A (Sprint 22): HTTP MCP клиент через broker — транспорт, схема, registry.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HttpMcpClient } from '../../src/mcp/http-transport.ts';
import { HttpMcpRunner } from '../../src/mcp/runner.ts';
import { loadMcpRegistry, findMcpServer } from '../../src/mcp/registry.ts';
import { clearMcpActions } from '../../src/host/gate/mcp-actions.ts';
import { mcpServerSchema } from '../../src/config/schema.ts';

interface SeenRequest {
  headers: IncomingMessage['headers'];
  body: { method?: string };
}

function fakeMcpServer(opts?: { replyText?: string; isError?: boolean; contentType?: string }) {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id?: number; method?: string };
      seen.push({ headers: req.headers, body });
      if (body.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        body.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } }
          : {
              content: [{ type: 'text', text: opts?.replyText ?? 'http-mcp-reply' }],
              isError: opts?.isError ?? false,
            };
      res.writeHead(200, {
        'content-type': opts?.contentType ?? 'application/json',
        'mcp-session-id': 'sess-42',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  return { server, seen };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`127.0.0.1:${addr.port}`);
    });
  });
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});
afterEach(() => clearMcpActions());

describe('HttpMcpClient (P-A)', () => {
  it('initialize → initialized → tools/call, session id echoed, Host = upstream', async () => {
    const { server, seen } = fakeMcpServer();
    servers.push(server);
    const brokerHost = await listen(server);

    const client = new HttpMcpClient({ brokerHost, host: 'mcp.example.com', timeoutMs: 5000 });
    const result = await client.callTool('echo', { text: 'hi' });

    expect(result.content).toBe('http-mcp-reply');
    expect(result.isError).toBe(false);
    expect(seen.map((r) => r.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    for (const r of seen) expect(r.headers.host).toBe('mcp.example.com');
    // Session id из initialize повторяется в последующих запросах.
    expect(seen[1]!.headers['mcp-session-id']).toBe('sess-42');
    expect(seen[2]!.headers['mcp-session-id']).toBe('sess-42');
  });

  it('V2: запросы не содержат auth-заголовков даже при env-секрете', async () => {
    const prev = process.env.AEGIS_TEST_SECRET_LEAK;
    process.env.AEGIS_TEST_SECRET_LEAK = 'must-not-reach-broker-request';
    const { server, seen } = fakeMcpServer();
    servers.push(server);
    const brokerHost = await listen(server);

    const client = new HttpMcpClient({ brokerHost, host: 'mcp.example.com', timeoutMs: 5000 });
    await client.callTool('echo', {});

    for (const r of seen) {
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers['x-api-key']).toBeUndefined();
      expect(JSON.stringify(r.headers)).not.toContain('must-not-reach-broker-request');
    }
    if (prev === undefined) delete process.env.AEGIS_TEST_SECRET_LEAK;
    else process.env.AEGIS_TEST_SECRET_LEAK = prev;
  });

  it('isError result → HttpMcpRunner throws', async () => {
    const { server } = fakeMcpServer({ replyText: 'boom', isError: true });
    servers.push(server);
    const brokerHost = await listen(server);

    const runner = new HttpMcpRunner();
    await expect(
      runner.call(
        {
          name: 'fake',
          transport: 'http',
          broker_host: brokerHost,
          host: 'mcp.example.com',
          tools: [{ name: 'echo', action_class: 'read-only' }],
        },
        'echo',
        {},
      ),
    ).rejects.toThrow('boom');
  });

  it('не-JSON ответ (SSE) → внятная ошибка', async () => {
    const { server } = fakeMcpServer({ contentType: 'text/event-stream' });
    servers.push(server);
    const brokerHost = await listen(server);

    const client = new HttpMcpClient({ brokerHost, host: 'mcp.example.com', timeoutMs: 5000 });
    await expect(client.callTool('echo', {})).rejects.toThrow('SSE not supported');
  });
});

describe('mcp http config (P-A)', () => {
  const valid = {
    name: 'notion',
    transport: 'http',
    broker_host: 'aegis-broker:8080',
    host: 'mcp.notion.com',
    tools: [{ name: 'search', action_class: 'read-only' }],
  };

  it('валидный http-конфиг проходит', () => {
    expect(mcpServerSchema.parse(valid).transport).toBe('http');
  });

  it('V2: поле token отклоняется схемой (strict)', () => {
    expect(() => mcpServerSchema.parse({ ...valid, token: 'secret' })).toThrow();
    expect(() => mcpServerSchema.parse({ ...valid, api_key_ref: 'X' })).toThrow();
  });

  it('command у http-транспорта отклоняется', () => {
    expect(() => mcpServerSchema.parse({ ...valid, command: ['node', 'x.mjs'] })).toThrow();
  });

  it('registry регистрирует http-сервер и находит его', () => {
    const loaded = loadMcpRegistry({ servers: [mcpServerSchema.parse(valid)] });
    expect(loaded).toHaveLength(1);
    expect(findMcpServer(loaded, 'notion')?.transport).toBe('http');
  });
});
