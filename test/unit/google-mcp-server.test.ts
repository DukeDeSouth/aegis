/**
 * Sprint 24 / C1: connectors/google/server/server.mjs — stdio-MCP протокол,
 * Host-паттерн через broker, отсутствие Authorization в запросах (V2).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../../src/mcp/stdio-transport.ts';

const SERVER = join(process.cwd(), 'connectors', 'google', 'server', 'server.mjs');

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

describe('google MCP server (C1)', () => {
  it('calendar_list: Host www.googleapis.com, выжимка событий, БЕЗ Authorization', async () => {
    const { port, seen } = await startFakeBroker(() => ({
      status: 200,
      json: {
        items: [
          { summary: 'Standup', start: { dateTime: '2026-07-07T10:00:00+02:00' } },
          { summary: 'Lunch', start: { date: '2026-07-07' } },
        ],
      },
    }));
    const result = await client(port).callTool('calendar_list', {});

    expect(result.isError).toBe(false);
    expect(result.content).toContain('2026-07-07T10:00:00+02:00 — Standup');
    expect(result.content).toContain('2026-07-07 — Lunch');
    expect(seen[0]!.host).toBe('www.googleapis.com');
    expect(seen[0]!.url).toContain('/calendar/v3/calendars/primary/events');
    // V2: клиентский код не добавляет кредов — их инжектит только broker.
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('gmail_search: query кодируется, Host gmail.googleapis.com', async () => {
    const { port, seen } = await startFakeBroker(() => ({
      status: 200,
      json: { messages: [{ id: 'm1' }, { id: 'm2' }] },
    }));
    const result = await client(port).callTool('gmail_search', { q: 'from:boss is:unread' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('2 message(s): m1, m2');
    expect(seen[0]!.host).toBe('gmail.googleapis.com');
    expect(seen[0]!.url).toContain('q=from%3Aboss%20is%3Aunread');
  });

  it('gmail_get: MIME encoded-word в Subject', async () => {
    const { port } = await startFakeBroker(() => ({
      status: 200,
      json: {
        snippet: 'body',
        payload: {
          headers: [
            { name: 'From', value: 'a@b.c' },
            { name: 'Subject', value: '=?UTF-8?B?0J/RgNC40LLQtdGC?=' },
            { name: 'Date', value: 'Tue' },
          ],
        },
      },
    }));
    const result = await client(port).callTool('gmail_get', { id: 'm1' });
    expect(result.content).toContain('Subject: Привет');
  });

  it('gmail_get: заголовки и snippet', async () => {
    const { port } = await startFakeBroker(() => ({
      status: 200,
      json: {
        snippet: 'Meeting moved to 3pm',
        payload: {
          headers: [
            { name: 'From', value: 'boss@corp.com' },
            { name: 'Subject', value: 'Re: schedule' },
            { name: 'Date', value: 'Tue, 7 Jul 2026' },
          ],
        },
      },
    }));
    const result = await client(port).callTool('gmail_get', { id: 'm1' });
    expect(result.content).toContain('From: boss@corp.com');
    expect(result.content).toContain('Subject: Re: schedule');
    expect(result.content).toContain('Meeting moved to 3pm');
  });

  it('gmail_send: POST send с base64url RFC822', async () => {
    const { port, seen } = await startFakeBroker(() => ({ status: 200, json: { id: 'sent-1' } }));
    const result = await client(port).callTool('gmail_send', {
      to: 'a@b.c',
      subject: 'Hello',
      body: 'Line one',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe('sent: sent-1');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/gmail/v1/users/me/messages/send');
    const raw = (JSON.parse(seen[0]!.body) as { raw: string }).raw;
    const rfc = Buffer.from(raw, 'base64url').toString('utf8');
    expect(rfc).toContain('To: a@b.c');
    expect(rfc).toContain('Subject: Hello');
    expect(rfc).toContain('Line one');
  });

  it('401 от broker → isError с подсказкой про sidecar', async () => {
    const { port } = await startFakeBroker(() => ({ status: 401, json: {} }));
    const result = await client(port).callTool('gmail_list', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('oauth-sidecar');
  });

  it('неизвестный tool и отсутствующий аргумент → isError, не crash', async () => {
    const { port, seen } = await startFakeBroker(() => ({ status: 200, json: {} }));
    const unknown = await client(port).callTool('rm_rf', {});
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('unknown tool');

    const missing = await client(port).callTool('gmail_send', { subject: 'x' });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('missing argument: to');
    expect(seen.length).toBe(0); // до broker дело не дошло
  });

  it('argv с мусором (как после sandbox-bridge) → дефолт aegis-broker, broker unreachable', async () => {
    const c = new StdioMcpClient({
      command: ['node', SERVER, '/mcp-server/--broker'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 10_000,
    });
    const result = await c.callTool('gmail_list', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('broker unreachable');
  });

  it('drive_list: Host www.googleapis.com, files listed', async () => {
    const { port, seen } = await startFakeBroker(() => ({
      status: 200,
      json: { files: [{ id: 'f1', name: 'notes.txt', mimeType: 'text/plain' }] },
    }));
    const result = await client(port).callTool('drive_list', {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('f1: notes.txt');
    expect(seen[0]!.url).toContain('/drive/v3/files');
  });

  it('drive_get_text: raw body returned', async () => {
    const { port } = await startFakeBroker((_req, _body) => ({
      status: 200,
      json: 'hello drive',
    }));
    const result = await client(port).callTool('drive_get_text', { id: 'f1' });
    expect(result.content).toContain('hello drive');
  });
});
