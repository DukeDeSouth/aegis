import { describe, expect, it } from 'vitest';
import { extractContiguousChains, episodeActionToken } from '../../src/skills/proposal.ts';

describe('skill chain detect (L3)', () => {
  it('extracts contiguous capability chains', () => {
    const tokens = [
      episodeActionToken('/digest'),
      episodeActionToken('/write reports/x | body'),
    ];
    const chains = extractContiguousChains(tokens, 2, 3);
    expect(chains).toContain('chain:web.fetch>files.write');
  });

  it('ignores pure message chains without two capabilities', () => {
    const tokens = [episodeActionToken('hello'), episodeActionToken('world')];
    expect(extractContiguousChains(tokens, 2, 3)).toEqual([]);
  });

  it('finds chain inside longer session', () => {
    const tokens = [
      episodeActionToken('/status'),
      episodeActionToken('/digest'),
      episodeActionToken('/write a | b'),
      episodeActionToken('thanks'),
    ];
    const chains = extractContiguousChains(tokens, 2, 3);
    expect(chains).toContain('chain:web.fetch>files.write');
  });
});
