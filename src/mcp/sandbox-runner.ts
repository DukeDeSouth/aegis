/**
 * F8: MCP tool call через hardened Docker sandbox (Node bridge + /mcp-server mount).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig } from '../config/schema.ts';
import type { SandboxRunner } from '../sandbox/types.ts';
import type { McpRunner } from './runner.ts';

const DEFAULT_BRIDGE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../skills/mcp-stdio-bridge',
);

const MCP_SERVER_MOUNT = '/mcp-server';

export interface SandboxMcpRunnerOptions {
  bridgeDir?: string;
  /** Node-образ с `node` в PATH (не alpine:3.x без node). */
  image: string;
}

type StdioServer = McpServerConfig & { transport: 'stdio' };

function assertStdio(server: McpServerConfig): asserts server is StdioServer {
  if (server.transport !== 'stdio') {
    throw new Error(`mcp ${server.name}: sandbox runner got ${server.transport}`);
  }
}

function containerCommand(server: StdioServer): string[] {
  const { command, server_dir: serverDir } = server;
  if (serverDir === undefined) {
    throw new Error(`mcp server ${server.name}: server_dir required for sandbox transport`);
  }
  const bin = command[0]!;
  const rest = command.slice(1).map((p) => `${MCP_SERVER_MOUNT}/${p.replace(/^\.\//, '')}`);
  return [bin, ...rest];
}

export class SandboxMcpRunner implements McpRunner {
  private readonly runner: SandboxRunner;
  private readonly bridgeDir: string;
  private readonly image: string;

  constructor(runner: SandboxRunner, opts: SandboxMcpRunnerOptions) {
    this.runner = runner;
    this.bridgeDir = opts.bridgeDir ?? DEFAULT_BRIDGE_DIR;
    this.image = opts.image;
  }

  async call(server: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string> {
    assertStdio(server);
    if (server.server_dir === undefined) {
      throw new Error(`mcp server ${server.name}: server_dir required`);
    }
    const cmd = containerCommand(server);
    const result = await this.runner.run(
      this.bridgeDir,
      'invoke.sh',
      {
        timeoutMs: 30_000,
        memoryBytes: 128 * 1024 * 1024,
        allowedHosts: server.allowed_hosts ?? [],
      },
      {
        MCP_COMMAND_JSON: JSON.stringify(cmd),
        MCP_TOOL: tool,
        MCP_ARGS_JSON: JSON.stringify(args),
        PATH: '/usr/local/bin:/usr/bin:/bin',
      },
      {
        image: this.image,
        extraMounts: [
          { hostPath: resolve(server.server_dir), containerPath: MCP_SERVER_MOUNT, readOnly: true },
        ],
      },
    );
    if (result.timedOut) throw new Error('mcp sandbox timed out');
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `mcp exit ${result.exitCode}`);
    }
    return result.stdout.trim();
  }
}

/**
 * Маршрутизация по транспорту: http → broker-клиент; stdio+server_dir → sandbox;
 * host stdio (direct) — только для тестов без Docker.
 */
export class DelegatingMcpRunner implements McpRunner {
  constructor(
    private readonly sandbox: McpRunner,
    private readonly direct: McpRunner,
    private readonly http?: McpRunner,
  ) {}

  async call(server: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string> {
    if (server.transport === 'http') {
      if (!this.http) throw new Error(`mcp ${server.name}: http runner not configured`);
      return this.http.call(server, tool, args);
    }
    if (server.server_dir !== undefined) return this.sandbox.call(server, tool, args);
    return this.direct.call(server, tool, args);
  }
}
