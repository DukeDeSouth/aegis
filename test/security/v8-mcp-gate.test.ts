/**
 * V8 (F8): MCP fail-closed + env isolation (расширение V2).
 * Sprint 22 (P-A): + HTTP-транспорт — auth только у broker.
 * Sprint 24 (P-B/C1): + OAuth-контур — сырой токен не существует нигде, кроме
 * файлов sidecar/broker; конфиг ядра, env MCP-процесса и код сервера чисты.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../../src/mcp/stdio-transport.ts';
import { HttpMcpClient } from '../../src/mcp/http-transport.ts';
import { mcpServerSchema } from '../../src/config/schema.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

function mockChild(): ChildProcessWithoutNullStreams {
  const stdin = new EventEmitter() as ChildProcessWithoutNullStreams['stdin'];
  (stdin as { write: (s: string) => boolean }).write = () => true;
  (stdin as { end: () => void }).end = () => undefined;
  const stdout = new EventEmitter() as ChildProcessWithoutNullStreams['stdout'];
  const stderr = new EventEmitter() as ChildProcessWithoutNullStreams['stderr'];
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = () => true;
  return proc;
}

describe('mcp security (F8)', () => {
  it('stdio client does not pass host secrets in env', async () => {
    const prev = process.env.AEGIS_TEST_SECRET_LEAK;
    process.env.AEGIS_TEST_SECRET_LEAK = 'must-not-reach-mcp';

    let seenEnv: NodeJS.ProcessEnv | undefined;
    const client = new StdioMcpClient({
      command: ['node', 'noop.mjs'],
      env: { PATH: '/usr/bin' },
      spawn: (_cmd, _args, opts) => {
        seenEnv = opts.env;
        return mockChild();
      },
      timeoutMs: 50,
    });

    await expect(client.callTool('x', {})).rejects.toThrow();
    expect(seenEnv).toBeDefined();
    expect(seenEnv!.AEGIS_TEST_SECRET_LEAK).toBeUndefined();
    expect(seenEnv!.PATH).toBe('/usr/bin');

    if (prev === undefined) delete process.env.AEGIS_TEST_SECRET_LEAK;
    else process.env.AEGIS_TEST_SECRET_LEAK = prev;
  });

  it('V2/HTTP: у http-конфига нет места для секрета (strict schema)', () => {
    const base = {
      name: 'srv',
      transport: 'http',
      broker_host: 'aegis-broker:8080',
      host: 'mcp.example.com',
      tools: [{ name: 't', action_class: 'read-only' }],
    };
    expect(() => mcpServerSchema.parse({ ...base, token: 'x' })).toThrow();
    expect(() => mcpServerSchema.parse({ ...base, authorization: 'Bearer x' })).toThrow();
    expect(() => mcpServerSchema.parse({ ...base, headers: { Authorization: 'x' } })).toThrow();
    expect(mcpServerSchema.parse(base).transport).toBe('http');
  });

  it('V2/HTTP: клиент не отправляет auth-заголовки — инжекция только у broker', async () => {
    const prev = process.env.AEGIS_TEST_SECRET_LEAK;
    process.env.AEGIS_TEST_SECRET_LEAK = 'must-not-leave-core';

    const authHeaders: (string | undefined)[] = [];
    httpFixture = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        authHeaders.push(req.headers.authorization);
        const body = JSON.parse(raw) as { id?: number };
        if (body.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: 'ok' }], isError: false },
          }),
        );
      });
    });
    const brokerHost = await new Promise<string>((resolve) => {
      httpFixture!.listen(0, '127.0.0.1', () => {
        const addr = httpFixture!.address() as { port: number };
        resolve(`127.0.0.1:${addr.port}`);
      });
    });

    const client = new HttpMcpClient({ brokerHost, host: 'mcp.example.com', timeoutMs: 5000 });
    await client.callTool('t', {});

    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((a) => a === undefined)).toBe(true);

    if (prev === undefined) delete process.env.AEGIS_TEST_SECRET_LEAK;
    else process.env.AEGIS_TEST_SECRET_LEAK = prev;
  });

  it('V2/OAuth (Sprint 24): stdio-конфиг ядра не принимает поля токенов (strict)', () => {
    const base = {
      name: 'google',
      transport: 'stdio',
      command: ['node', 'server.mjs'],
      server_dir: './connectors/google/server',
      allowed_hosts: ['aegis-broker'],
      tools: [{ name: 'gmail_list', action_class: 'read-only' }],
    };
    expect(mcpServerSchema.parse(base).transport).toBe('stdio');
    expect(() => mcpServerSchema.parse({ ...base, access_token: 'ya29.x' })).toThrow();
    expect(() => mcpServerSchema.parse({ ...base, refresh_token: '1//x' })).toThrow();
    expect(() => mcpServerSchema.parse({ ...base, env: { GOOGLE_TOKEN: 'x' } })).toThrow();
  });

  it('V2/OAuth: код google-сервера и sidecar не содержат кредов и не выставляют Authorization', () => {
    const server = readFileSync(
      join(process.cwd(), 'connectors', 'google', 'server', 'server.mjs'),
      'utf8',
    );
    // Присваивание Authorization-заголовка невозможно по построению.
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
    expect(/ya29|client_secret/i.test(server)).toBe(false);

    const sidecar = readFileSync(
      join(process.cwd(), 'deploy', 'broker', 'oauth-sidecar', 'sidecar.mjs'),
      'utf8',
    );
    // Sidecar логирует только статус: ни один console.* не интерполирует токены.
    const logCalls = sidecar.match(/console\.(log|error)\([^)]*\)/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(/access_token|refresh_token|creds\.|data\./.test(call), call).toBe(false);
    }
  });
});

let httpFixture: Server | undefined;
afterAll(() => httpFixture?.close());
