/**
 * Сборка системного контекста: инжекция trusted knowledge (Sprint 5).
 */
import type { KnowledgeRow } from './knowledge.ts';
import type { KnowledgeStore } from './knowledge.ts';

const KNOWLEDGE_HEADER = '## Trusted knowledge';

export function formatKnowledgeBlock(
  rows: KnowledgeRow[],
  truncate: (body: string) => string,
): string {
  if (rows.length === 0) return '';
  const lines = rows.map(
    (k) => `- [${k.epistemicStatus}/${k.provenance}] ${k.title}: ${truncate(k.body)}`,
  );
  return `${KNOWLEDGE_HEADER}\n${lines.join('\n')}`;
}

export function buildSystemPrompt(base: string, knowledgeBlock: string): string {
  if (!knowledgeBlock) return base;
  return `${base}\n\n${knowledgeBlock}`;
}

export function buildPromptWithKnowledge(
  base: string,
  store: KnowledgeStore,
): { prompt: string; injected: KnowledgeRow[] } {
  const injected = store.listForInjection();
  const block = formatKnowledgeBlock(injected, (b) => store.truncateBody(b));
  return { prompt: buildSystemPrompt(base, block), injected };
}
