/**
 * V1 (Sprint 32 / C13): injection в ответе Postiz analytics не попадает в P-LLM.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('social injection (C13)', () => {
  it('MCP server не содержит Authorization — секрет только у broker', () => {
    const server = readFileSync(
      join(process.cwd(), 'connectors', 'social', 'server', 'server.mjs'),
      'utf8',
    );
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
  });
});
