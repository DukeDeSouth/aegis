import { describe, expect, it } from 'vitest';
import { buildWebchatActions, skillQuickText, OWNER_QUICK_COMMANDS } from '../../src/host/adapter/webchat/actions.ts';

describe('webchat actions', () => {
  it('maps known skills to quick text', () => {
    expect(skillQuickText('agent-status')).toBe('/status');
    expect(skillQuickText('web-digest')).toBe('/digest');
  });

  it('buildWebchatActions includes skills then owner commands', () => {
    const actions = buildWebchatActions([
      { name: 'echo-procedure', description: 'Echo', code: false, actionClass: 'read-only' },
    ]);
    expect(actions[0]?.id).toBe('skill-echo-procedure');
    expect(actions.at(-1)?.id).toBe(OWNER_QUICK_COMMANDS.at(-1)?.id);
  });
});
