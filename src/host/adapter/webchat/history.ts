/**
 * Map episode rows to WebChat history JSON (owner/assistant only).
 */
import type { EpisodeRow } from '../../../memory/episodes.ts';

export interface WebchatHistoryMessage {
  readonly id: number;
  readonly role: 'user' | 'bot';
  readonly text: string;
}

const MAX_HISTORY = 100;

export function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(MAX_HISTORY, Math.max(1, Math.floor(limit)));
}

export function episodesToHistoryMessages(rows: EpisodeRow[]): WebchatHistoryMessage[] {
  return rows
    .filter((r) => r.role === 'owner' || r.role === 'assistant')
    .map((r) => ({
      id: r.id,
      role: r.role === 'owner' ? 'user' : 'bot',
      text: r.content,
    }));
}
