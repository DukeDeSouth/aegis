/**
 * F8: динамический реестр gate-действий MCP (только из config, fail-closed).
 */
import type { ActionSpec } from './actions.ts';
import type { ActionClass } from './types.ts';

const mcpActions: Record<string, ActionSpec> = {};

export function registerMcpTool(
  server: string,
  tool: string,
  actionClass: ActionClass,
  requiresBroker = false,
): void {
  const id = `mcp.${server}.${tool}`;
  mcpActions[id] = {
    id,
    actionClass,
    requiresBroker,
    quarantineRequired: true,
  };
}

export function clearMcpActions(): void {
  for (const key of Object.keys(mcpActions)) delete mcpActions[key];
}

export function lookupMcpAction(actionId: string): ActionSpec | undefined {
  return mcpActions[actionId];
}
