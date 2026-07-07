/**
 * Идентификатор gate-действия для MCP tool (F8).
 */
const SERVER_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOOL_RE = /^[a-zA-Z0-9_-]+$/;

export function mcpActionId(server: string, tool: string): string {
  if (!SERVER_RE.test(server)) throw new Error(`invalid mcp server name: ${server}`);
  if (!TOOL_RE.test(tool)) throw new Error(`invalid mcp tool name: ${tool}`);
  return `mcp.${server}.${tool}`;
}

export function parseMcpActionId(actionId: string): { server: string; tool: string } | undefined {
  if (!actionId.startsWith('mcp.')) return undefined;
  const rest = actionId.slice(4);
  const dot = rest.indexOf('.');
  if (dot <= 0) return undefined;
  const server = rest.slice(0, dot);
  const tool = rest.slice(dot + 1);
  if (!SERVER_RE.test(server) || !TOOL_RE.test(tool)) return undefined;
  return { server, tool };
}
