/**
 * Sprint 25 / C5: connectors/github/server/server.mjs
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../../src/mcp/stdio-transport.ts';

const SERVER = join(process.cwd(), 'connectors', 'github', 'server', 'server.mjs');

interface SeenRequest {
  method: string;
  url: string;
  host: string | undefined;
  authorization: string | undefined;
  accept: string | undefined;
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
          accept: req.headers.accept,
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

describe('github MCP server (C5)', () => {
  it('issue_get: Host api.github.com, GitHub Accept, БЕЗ Authorization', async () => {
    const { port, seen } = await startFakeBroker(() => ({
      status: 200,
      json: { number: 42, state: 'open', title: 'Bug', body: 'details' },
    }));
    const result = await client(port).callTool('issue_get', {
      owner: 'acme',
      repo: 'app',
      number: 42,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('#42 [open] Bug');
    expect(result.content).toContain('details');
    expect(seen[0]!.host).toBe('api.github.com');
    expect(seen[0]!.url).toBe('/repos/acme/app/issues/42');
    expect(seen[0]!.accept).toBe('application/vnd.github+json');
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('pr_merge: PUT merge endpoint', async () => {
    const { port, seen } = await startFakeBroker(() => ({
      status: 200,
      json: { sha: 'abc123' },
    }));
    const result = await client(port).callTool('pr_merge', {
      owner: 'acme',
      repo: 'app',
      number: 7,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('abc123');
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toBe('/repos/acme/app/pulls/7/merge');
  });

  it('issue_create: POST с title', async () => {
    const { port, seen } = await startFakeBroker(() => ({
      status: 201,
      json: { number: 99 },
    }));
    const result = await client(port).callTool('issue_create', {
      owner: 'acme',
      repo: 'app',
      title: 'New bug',
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('#99');
    expect(seen[0]!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.body)).toEqual({ title: 'New bug' });
  });
});
