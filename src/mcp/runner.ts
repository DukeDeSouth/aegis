/**
 * F8: вызов MCP tool через stdio (host запускает процесс с минимальным env).
 * P-A (Sprint 22): + HTTP-транспорт через credential broker.
 */
import type { McpHttpServerConfig, McpServerConfig } from '../config/schema.ts';
import { HttpMcpClient } from './http-transport.ts';
import { StdioMcpClient } from './stdio-transport.ts';

export interface McpRunner {
  call(server: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string>;
}

export class StdioMcpRunner implements McpRunner {
  async call(server: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string> {
    if (server.transport !== 'stdio') throw new Error(`mcp ${server.name}: stdio runner got ${server.transport}`);
    const client = new StdioMcpClient({
      command: server.command,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const result = await client.callTool(tool, args);
    if (result.isError) throw new Error(result.content);
    return result.content;
  }
}

/** HTTP MCP через broker: ядро говорит только с брокером, токен инжектит Envoy (V2). */
export class HttpMcpRunner implements McpRunner {
  async call(server: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string> {
    if (server.transport !== 'http') throw new Error(`mcp ${server.name}: http runner got ${server.transport}`);
    const client = httpClientFor(server);
    const result = await client.callTool(tool, args);
    if (result.isError) throw new Error(result.content);
    return result.content;
  }
}

function httpClientFor(server: McpHttpServerConfig): HttpMcpClient {
  return new HttpMcpClient({
    brokerHost: server.broker_host,
    host: server.host,
    ...(server.path !== undefined ? { path: server.path } : {}),
  });
}
