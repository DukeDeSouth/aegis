import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../../src/mcp/stdio-transport.ts';
import { parseMcpInvokeLine } from '../../src/mcp/parse-command.ts';

const ECHO_SERVER = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp/echo-server.mjs');

describe('mcp stdio client', () => {
  it('calls echo tool on fixture server', async () => {
    const client = new StdioMcpClient({
      command: [process.execPath, ECHO_SERVER],
      env: { PATH: process.env.PATH ?? '' },
    });
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('echo:hi');
  });
});

describe('parseMcpInvokeLine', () => {
  it('parses server tool and json args', () => {
    const p = parseMcpInvokeLine('/mcp echo echo {"text":"x"}');
    expect(p).toEqual({ server: 'echo', tool: 'echo', args: { text: 'x' } });
  });

  it('defaults empty args', () => {
    const p = parseMcpInvokeLine('/mcp echo echo');
    expect(p).toEqual({ server: 'echo', tool: 'echo', args: {} });
  });
});
