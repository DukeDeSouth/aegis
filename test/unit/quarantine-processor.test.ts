import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { QuarantineProcessor } from '../../src/host/quarantine/processor.ts';

describe('QuarantineProcessor', () => {
  it('вызывает Q-LLM и возвращает summary', async () => {
    let capturedUser = '';
    const qLlm: LlmClient = {
      complete(req): Promise<LlmResult> {
        capturedUser = req.messages.find((m) => m.role === 'user')?.content ?? '';
        expect(req).not.toHaveProperty('tools');
        return Promise.resolve({
          message: { role: 'assistant', content: 'summary text' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const processor = new QuarantineProcessor(qLlm);
    const out = await processor.process('untrusted body');
    expect(out.summary).toBe('summary text');
    expect(capturedUser).toBe('untrusted body');
  });
});
