/**
 * V8 (F8): MCP fail-closed + env isolation (расширение V2).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { StdioMcpClient } from '../../src/mcp/stdio-transport.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

function mockChild(): ChildProcessWithoutNullStreams {
  const stdin = new EventEmitter() as ChildProcessWithoutNullStreams['stdin'];
  (stdin as { write: (s: string) => boolean }).write = () => true;
  (stdin as { end: () => void }).end = () => {};
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
});
