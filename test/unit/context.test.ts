import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, formatKnowledgeBlock } from '../../src/memory/context.ts';
import type { KnowledgeRow } from '../../src/memory/knowledge.ts';

const sample: KnowledgeRow[] = [
  {
    id: 1,
    kind: 'fact',
    title: 'API URL',
    body: 'https://api.example.com',
    epistemicStatus: 'corroborated',
    provenance: 'owner',
    createdAt: 1,
    updatedAt: 1,
  },
];

describe('memory context', () => {
  it('formatKnowledgeBlock пустой для []', () => {
    expect(formatKnowledgeBlock([], (b) => b)).toBe('');
  });

  it('buildSystemPrompt добавляет блок знаний', () => {
    const block = formatKnowledgeBlock(sample, (b) => b);
    const prompt = buildSystemPrompt('Base', block);
    expect(prompt).toContain('Base');
    expect(prompt).toContain('## Trusted knowledge');
    expect(prompt).toContain('API URL');
  });
});
