import { describe, expect, it, afterEach } from 'vitest';
import { evaluate } from '../../src/host/gate/engine.ts';
import { clearMcpActions, registerMcpTool } from '../../src/host/gate/mcp-actions.ts';
import { mcpActionId } from '../../src/mcp/action-id.ts';
import { loadMcpRegistry } from '../../src/mcp/registry.ts';

const deps = { brokerAvailable: true, gateHealthy: true };

afterEach(() => clearMcpActions());

describe('mcp gate', () => {
  it('mapped tool allows owner read-only', () => {
    registerMcpTool('echo', 'echo', 'read-only');
    const d = evaluate({ actionId: mcpActionId('echo', 'echo'), provenance: 'owner' }, deps);
    expect(d.verdict).toBe('allow');
  });

  it('unmapped tool denies fail-closed', () => {
    const d = evaluate({ actionId: mcpActionId('echo', 'missing'), provenance: 'owner' }, deps);
    expect(d.verdict).toBe('deny');
  });

  it('quarantine provenance denies mcp effect', () => {
    registerMcpTool('echo', 'echo', 'read-only');
    const d = evaluate({ actionId: mcpActionId('echo', 'echo'), provenance: 'quarantine' }, deps);
    expect(d.verdict).toBe('deny');
  });

  it('loadMcpRegistry registers config tools', () => {
    const servers = loadMcpRegistry({
      servers: [
        {
          name: 'fixture',
          transport: 'stdio',
          command: ['node', 'x.mjs'],
          tools: [{ name: 't1', action_class: 'read-only' }],
        },
      ],
    });
    expect(servers).toHaveLength(1);
    const d = evaluate({ actionId: 'mcp.fixture.t1', provenance: 'owner' }, deps);
    expect(d.verdict).toBe('allow');
  });
});
