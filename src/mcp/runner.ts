/**
 * F8: вызов MCP tool через stdio (host запускает процесс с минимальным env).
 */
import type { McpServerConfig } from '../config/schema.ts';
import { StdioMcpClient } from './stdio-transport.ts';

type StdioServer = McpServerConfig & { transport: 'stdio' };

export interface McpRunner {
  call(server: StdioServer, tool: string, args: Record<string, unknown>): Promise<string>;
}

export class StdioMcpRunner implements McpRunner {
  async call(server: StdioServer, tool: string, args: Record<string, unknown>): Promise<string> {
    const client = new StdioMcpClient({
      command: server.command,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const result = await client.callTool(tool, args);
    if (result.isError) throw new Error(result.content);
    return result.content;
  }
}
