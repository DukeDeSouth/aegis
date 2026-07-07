import { describe, expect, it } from 'vitest';
import { parseHttpsUrlsFromMarkdown } from '../../src/skills/urls.ts';

describe('parseHttpsUrlsFromMarkdown', () => {
  it('extracts unique https URLs', () => {
    const md = `# Sources\n- https://a.com/x\n- https://b.com\n`;
    expect(parseHttpsUrlsFromMarkdown(md)).toEqual(['https://a.com/x', 'https://b.com']);
  });
});
