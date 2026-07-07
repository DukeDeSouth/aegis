/**
 * Разбор `/mcp <server> <tool> [json-args]`.
 */
export interface ParsedMcpInvoke {
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export function parseMcpInvokeLine(text: string): ParsedMcpInvoke | { error: string } {
  const prefix = '/mcp ';
  if (!text.startsWith(prefix)) return { error: 'not an mcp command' };
  const body = text.slice(prefix.length).trim();
  if (body.length === 0) {
    return { error: 'Usage: /mcp <server> <tool> [json-args]' };
  }

  const firstSpace = body.indexOf(' ');
  if (firstSpace <= 0) return { error: 'Usage: /mcp <server> <tool> [json-args]' };
  const server = body.slice(0, firstSpace).trim();
  const rest = body.slice(firstSpace + 1).trim();
  const secondSpace = rest.indexOf(' ');
  const tool = (secondSpace < 0 ? rest : rest.slice(0, secondSpace)).trim();
  const jsonPart = secondSpace < 0 ? '' : rest.slice(secondSpace + 1).trim();

  if (!server || !tool) return { error: 'Usage: /mcp <server> <tool> [json-args]' };

  let args: Record<string, unknown> = {};
  if (jsonPart.length > 0) {
    try {
      const parsed: unknown = JSON.parse(jsonPart);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'json-args must be a JSON object' };
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return { error: 'invalid json-args' };
    }
  }

  return { server, tool, args };
}

export function formatMcpList(
  servers: readonly { name: string; tools: readonly { name: string; action_class: string }[] }[],
): string {
  if (servers.length === 0) return 'No MCP servers configured.';
  const lines = ['MCP servers (config only):'];
  for (const s of servers) {
    const tools = s.tools.map((t) => `${t.name}(${t.action_class})`).join(', ');
    lines.push(`- ${s.name}: ${tools}`);
  }
  return lines.join('\n');
}
