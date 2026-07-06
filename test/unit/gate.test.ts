import { describe, expect, it } from 'vitest';
import { evaluate, type GateDeps } from '../../src/host/gate/engine.ts';

const healthy: GateDeps = { brokerAvailable: true, gateHealthy: true };
const brokerDown: GateDeps = { brokerAvailable: false, gateHealthy: true };
const gateDown: GateDeps = { brokerAvailable: true, gateHealthy: false };

describe('GateEngine.evaluate', () => {
  it('read-only + owner → allow', () => {
    const d = evaluate({ actionId: 'memory.read', provenance: 'owner' }, healthy);
    expect(d.verdict).toBe('allow');
    expect(d.actionClass).toBe('read-only');
  });

  it('read-only + quarantine → deny', () => {
    const d = evaluate({ actionId: 'memory.read', provenance: 'quarantine' }, healthy);
    expect(d.verdict).toBe('deny');
  });

  it('reversible + owner → allow (llm.invoke, message.send)', () => {
    expect(evaluate({ actionId: 'llm.invoke', provenance: 'owner' }, healthy).verdict).toBe(
      'allow',
    );
    expect(evaluate({ actionId: 'message.send', provenance: 'owner' }, healthy).verdict).toBe(
      'allow',
    );
  });

  it('reversible + quarantine → deny (V1: данные не инициируют действие)', () => {
    const d = evaluate({ actionId: 'llm.invoke', provenance: 'quarantine' }, healthy);
    expect(d.verdict).toBe('deny');
    expect(d.reason).toContain('untrusted provenance');
  });

  it('reversible + scheduler → allow (S9 background)', () => {
    expect(evaluate({ actionId: 'llm.invoke', provenance: 'scheduler' }, healthy).verdict).toBe(
      'allow',
    );
    expect(evaluate({ actionId: 'message.send', provenance: 'scheduler' }, healthy).verdict).toBe(
      'allow',
    );
  });

  it('read-only + scheduler → allow memory.read', () => {
    expect(evaluate({ actionId: 'memory.read', provenance: 'scheduler' }, healthy).verdict).toBe(
      'allow',
    );
  });

  it('irreversible + scheduler → deny', () => {
    expect(
      evaluate({ actionId: 'action.dangerous', provenance: 'scheduler' }, healthy).verdict,
    ).toBe('deny');
  });

  it('irreversible без confirm → confirm_required', () => {
    const d = evaluate({ actionId: 'action.dangerous', provenance: 'owner' }, healthy);
    expect(d.verdict).toBe('confirm_required');
  });

  it('irreversible с confirmed → allow', () => {
    const d = evaluate(
      { actionId: 'action.dangerous', provenance: 'owner', confirmed: true },
      healthy,
    );
    expect(d.verdict).toBe('allow');
  });

  it('sandbox.run + broker down → deny (fail-closed)', () => {
    const d = evaluate({ actionId: 'sandbox.run', provenance: 'owner' }, brokerDown);
    expect(d.verdict).toBe('deny');
    expect(d.reason).toContain('broker');
  });

  it('gate unhealthy → deny всё (fail-closed)', () => {
    expect(evaluate({ actionId: 'llm.invoke', provenance: 'owner' }, gateDown).verdict).toBe(
      'deny',
    );
    expect(evaluate({ actionId: 'memory.read', provenance: 'owner' }, gateDown).verdict).toBe(
      'deny',
    );
  });

  it('unknown action → deny', () => {
    expect(evaluate({ actionId: 'nope', provenance: 'owner' }, healthy).verdict).toBe('deny');
  });

  it('skillActionClass поднимает эффективный класс (задел S8)', () => {
    const d = evaluate(
      {
        actionId: 'llm.invoke',
        provenance: 'owner',
        skillActionClass: 'irreversible',
      },
      healthy,
    );
    expect(d.verdict).toBe('confirm_required');
  });
});
