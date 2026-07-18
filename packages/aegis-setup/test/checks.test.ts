import { describe, expect, it } from 'vitest';
import { checkGvisorAvailable, type ExecFn } from '../src/checks.ts';

describe('checkGvisorAvailable', () => {
  it('fail когда runsc не зарегистрирован', async () => {
    const run: ExecFn = async (_cmd, args) => {
      if (args[0] === 'info') {
        return { stdout: '{"runc":{}}', stderr: '' };
      }
      throw new Error('unexpected');
    };
    const r = await checkGvisorAvailable(run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('runsc not registered');
  });

  it('ok когда runsc зарегистрирован и smoke проходит', async () => {
    const calls: string[][] = [];
    const run: ExecFn = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'info') {
        return { stdout: '{"runc":{},"runsc":{}}', stderr: '' };
      }
      if (args[0] === 'run') {
        return { stdout: '', stderr: '' };
      }
      throw new Error('unexpected');
    };
    const r = await checkGvisorAvailable(run);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.includes('runsc'))).toBe(true);
  });
});
