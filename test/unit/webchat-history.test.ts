import { describe, expect, it } from 'vitest';
import {
  clampHistoryLimit,
  episodesToHistoryMessages,
} from '../../src/host/adapter/webchat/history.ts';
import type { EpisodeRow } from '../../src/memory/episodes.ts';

function row(id: number, role: EpisodeRow['role'], content: string): EpisodeRow {
  return {
    id,
    session_id: 'webchat:local',
    role,
    content,
    provenance: 'owner',
    created_at: id,
  };
}

describe('webchat history', () => {
  it('maps owner/assistant to user/bot', () => {
    const msgs = episodesToHistoryMessages([
      row(1, 'owner', 'hi'),
      row(2, 'assistant', 'hello'),
    ]);
    expect(msgs).toEqual([
      { id: 1, role: 'user', text: 'hi' },
      { id: 2, role: 'bot', text: 'hello' },
    ]);
  });

  it('filters quarantine and system roles', () => {
    const msgs = episodesToHistoryMessages([
      row(1, 'owner', 'x'),
      row(2, 'quarantine', 'hidden'),
      row(3, 'system', 'sys'),
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
  });

  it('clampHistoryLimit defaults and caps', () => {
    expect(clampHistoryLimit(undefined)).toBe(50);
    expect(clampHistoryLimit(200)).toBe(100);
    expect(clampHistoryLimit(0)).toBe(1);
  });
});
