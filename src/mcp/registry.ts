/**
 * F8: загрузка MCP-серверов из config → gate registry.
 */
import { clearMcpActions, registerMcpTool } from '../host/gate/mcp-actions.ts';
import type { McpConfig, McpServerConfig } from '../config/schema.ts';

const SERVER_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function assertStdioServer(s: McpServerConfig): asserts s is McpServerConfig & { transport: 'stdio' } {
  if (s.transport !== 'stdio') throw new Error(`unsupported mcp transport: ${s.transport}`);
  if (s.command.length === 0) throw new Error(`mcp server ${s.name}: empty command`);
}

export function loadMcpRegistry(config: McpConfig | undefined): McpServerConfig[] {
  clearMcpActions();
  if (!config || config.servers.length === 0) return [];

  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];

  for (const server of config.servers) {
    if (!SERVER_NAME_RE.test(server.name)) {
      throw new Error(`invalid mcp server name: ${server.name}`);
    }
    if (seen.has(server.name)) throw new Error(`duplicate mcp server: ${server.name}`);
    seen.add(server.name);
    assertStdioServer(server);

    const toolNames = new Set<string>();
    for (const tool of server.tools) {
      if (toolNames.has(tool.name)) {
        throw new Error(`duplicate mcp tool ${server.name}.${tool.name}`);
      }
      toolNames.add(tool.name);
      registerMcpTool(server.name, tool.name, tool.action_class, false);
    }
    servers.push(server);
  }

  return servers;
}

export function findMcpServer(
  servers: readonly McpServerConfig[],
  name: string,
): (McpServerConfig & { transport: 'stdio' }) | undefined {
  const s = servers.find((x) => x.name === name);
  if (!s || s.transport !== 'stdio') return undefined;
  return s;
}

export function isMcpToolMapped(
  servers: readonly McpServerConfig[],
  server: string,
  tool: string,
): boolean {
  const s = findMcpServer(servers, server);
  return s?.tools.some((t) => t.name === tool) ?? false;
}
