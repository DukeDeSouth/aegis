import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SandboxMcpRunner } from '../../src/mcp/sandbox-runner.ts';
import type { McpServerConfig } from '../../src/config/schema.ts';
import type { SandboxRunner, SandboxRunResult } from '../../src/sandbox/types.ts';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/mcp');

describe('SandboxMcpRunner', () => {
  it('passes only bridge env and mounts server_dir', async () => {
    let capturedEnv: Record<string, string> | undefined;
    let capturedMounts: unknown;
    const fakeRunner: SandboxRunner = {
      run(_skillDir, entrypoint, limits, env, opts): Promise<SandboxRunResult> {
        capturedEnv = env;
        capturedMounts = opts?.extraMounts;
        expect(entrypoint).toBe('invoke.sh');
        expect(limits.allowedHosts).toEqual([]);
        return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false });
      },
    };

    const server: McpServerConfig = {
      name: 'echo',
      transport: 'stdio',
      server_dir: FIXTURE_DIR,
      command: ['node', 'echo-server.mjs'],
      tools: [{ name: 'echo', action_class: 'read-only' }],
    };

    const runner = new SandboxMcpRunner(fakeRunner, { image: 'node:24-alpine' });
    const out = await runner.call(server, 'echo', { text: 'x' });
    expect(out).toBe('ok');
    expect(capturedEnv?.MCP_TOOL).toBe('echo');
    expect(JSON.parse(capturedEnv!.MCP_COMMAND_JSON!)).toEqual([
      'node',
      '/mcp-server/echo-server.mjs',
    ]);
    expect(capturedEnv?.AEGIS_SECRET).toBeUndefined();
    expect(capturedMounts).toEqual([
      { hostPath: FIXTURE_DIR, containerPath: '/mcp-server', readOnly: true },
    ]);
  });
});
