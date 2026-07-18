import { describe, expect, it, vi } from 'vitest';
import {
  estimateResearchDeepTokens,
  parseDecomposePlan,
  ResearchDeepRunner,
  validateDecomposePlan,
} from '../../src/host/research/deep.ts';
import { QuarantineProcessor } from '../../src/host/quarantine/processor.ts';
import type { LlmClient } from '../../src/llm/types.ts';

describe('research-deep parser', () => {
  it('parseDecomposePlan принимает валидный JSON', () => {
    const plan = parseDecomposePlan('{"queries":["alpha market","beta pricing"]}');
    expect(plan.queries).toHaveLength(2);
  });

  it('validateDecomposePlan отклоняет слишком много queries', () => {
    expect(() =>
      validateDecomposePlan(
        { queries: ['a', 'b', 'c', 'd'] },
        3,
      ),
    ).toThrow(/at most 3/);
  });

  it('estimateResearchDeepTokens считает decompose + branches + synth', () => {
    expect(estimateResearchDeepTokens(3, 512, 1024)).toBe(512 + 3 * 512 + 1024);
  });
});

describe('ResearchDeepRunner', () => {
  it('run: decompose → parallel branches → synthesis', async () => {
    const fetchDigest = vi.fn(async (url: string) => ({
      ok: true as const,
      digest: `body for ${url}`,
    }));
    const qLlm: LlmClient = {
      complete: vi.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            queries: ['angle one', 'angle two'],
          }),
        },
        usage: { promptTokens: 10, completionTokens: 5, estimated: false },
      }),
    };
    const quarantine = new QuarantineProcessor({
      complete: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'branch summary' },
        usage: { promptTokens: 4, completionTokens: 2, estimated: false },
      }),
    });
    const pLlm: LlmClient = {
      complete: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Final report.' },
        usage: { promptTokens: 20, completionTokens: 10, estimated: false },
      }),
    };

    const runner = new ResearchDeepRunner({
      qLlm,
      pLlm,
      quarantine,
      fetchDigest,
      searchUrlTemplate: 'https://search.test/q={query}',
      branchCount: 3,
      synthesisSystemPrefix: 'SYS\nUNTRUSTED\n',
    });

    const result = await runner.run('competitors');
    expect(result.synthesis).toBe('Final report.');
    expect(result.branches).toHaveLength(2);
    expect(result.branches.every((b) => b.ok)).toBe(true);
    expect(fetchDigest).toHaveBeenCalledTimes(2);
  });

  it('run: все ветки failed — без synthesis', async () => {
    const qLlm: LlmClient = {
      complete: vi.fn().mockResolvedValue({
        message: {
          role: 'assistant',
          content: JSON.stringify({ queries: ['aaa', 'bbb'] }),
        },
        usage: { promptTokens: 1, completionTokens: 1, estimated: false },
      }),
    };
    const pLlm: LlmClient = { complete: vi.fn() };
    const runner = new ResearchDeepRunner({
      qLlm,
      pLlm,
      quarantine: new QuarantineProcessor({ complete: vi.fn() }),
      fetchDigest: async () => ({ ok: false, error: 'denied' }),
      searchUrlTemplate: 'https://x?q={query}',
      branchCount: 3,
      synthesisSystemPrefix: 'P\n',
    });
    const result = await runner.run('topic');
    expect(result.synthesis).toBe('');
    expect(pLlm.complete).not.toHaveBeenCalled();
  });
});
