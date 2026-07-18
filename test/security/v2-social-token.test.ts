/**
 * V2 (Sprint 32 / C13): Postiz API key отсутствует в connector preset и MCP server.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('social token isolation (C13)', () => {
  it('connector.json не содержит значений секрета', () => {
    const meta = JSON.parse(
      readFileSync(join(process.cwd(), 'connectors', 'social', 'connector.json'), 'utf8'),
    ) as Record<string, unknown>;
    const listener = JSON.stringify(meta.broker_listener ?? {});
    expect(listener).toContain('postiz_token');
    expect(listener).not.toMatch(/poz_[a-z0-9]+/i);
    const hints = JSON.stringify(meta.config_hints ?? []);
    expect(hints).not.toMatch(/gsk_|sk-/);
  });
});
