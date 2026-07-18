/**
 * Sprint 23: пресеты connectors/ — валидные навыки по ADR-0007.
 * Sprint 24: + google (broker_listener; ссылки на секрет — да, значения — нет).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifestFile } from '../../src/skills/validate.ts';

const CONNECTORS_DIR = join(process.cwd(), 'connectors');
const PRESETS = ['bookmarks', 'caldav', 'content-calendar', 'finance', 'github', 'google', 'homeassistant', 'inbox-triage', 'medialibrary', 'notes', 'notion', 'rss', 'search', 'shopping-list', 'social', 'travel', 'watch', 'weather'];

describe('connector presets', () => {
  it('каждый пресет — полный комплект файлов', () => {
    const dirs = readdirSync(CONNECTORS_DIR).sort();
    expect(dirs).toEqual(PRESETS);
    for (const name of dirs) {
      for (const f of ['connector.json', 'manifest.json', 'SKILL.md']) {
        expect(existsSync(join(CONNECTORS_DIR, name, f)), `${name}/${f}`).toBe(true);
      }
    }
  });

  it.each(PRESETS)('%s: manifest проходит валидацию навыков', (name) => {
    const dir = join(CONNECTORS_DIR, name);
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as unknown;
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const result = validateManifestFile(raw, dir, name, md);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('все пресеты декларативные (code:false) и без значений секретов в connector.json', () => {
    for (const name of PRESETS) {
      const manifest = JSON.parse(
        readFileSync(join(CONNECTORS_DIR, name, 'manifest.json'), 'utf8'),
      ) as { code: boolean };
      expect(manifest.code, name).toBe(false);
      const meta = JSON.parse(
        readFileSync(join(CONNECTORS_DIR, name, 'connector.json'), 'utf8'),
      ) as Record<string, unknown>;
      // broker_listener содержит только ССЫЛКИ (имя SDS-секрета, путь) — ни одного
      // поля со значением креда быть не может.
      const listener = JSON.stringify(meta.broker_listener ?? {});
      const listeners = JSON.stringify(meta.broker_listeners ?? []);
      for (const forbidden of ['client_secret', 'refresh_token', 'access_token', 'api_key']) {
        expect(listener.includes(forbidden), `${name}: ${forbidden}`).toBe(false);
        expect(listeners.includes(forbidden), `${name}: ${forbidden}`).toBe(false);
      }
      delete meta.broker_listener;
      delete meta.broker_listeners;
      delete meta.config_hints;
      const rest = JSON.stringify(meta);
      expect(/token|api_key|secret/i.test(rest.replace(/API key/g, '')), name).toBe(false);
    }
  });

  it('homeassistant (C4): lock_unlock irreversible; сервер без Authorization', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'homeassistant', 'connector.json'), 'utf8'),
    ) as { config_hints: string[] };
    const mcpHint = meta.config_hints.find((h) => h.includes('"transport"')) ?? '';
    expect(mcpHint).toContain('{"name": "lock_unlock", "action_class": "irreversible"}');
    expect(mcpHint).toContain('{"name": "states_list", "action_class": "read-only"}');
    expect(mcpHint).toContain('"server_dir": "./connectors/homeassistant/server"');
    const server = readFileSync(
      join(CONNECTORS_DIR, 'homeassistant', 'server', 'server.mjs'),
      'utf8',
    );
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
    expect(server).toContain('aegis-broker:8082');
  });

  it('github (C5): pr_merge irreversible; сервер без Authorization', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'github', 'connector.json'), 'utf8'),
    ) as { config_hints: string[] };
    const mcpHint = meta.config_hints.find((h) => h.includes('"transport"')) ?? '';
    expect(mcpHint).toContain('{"name": "pr_merge", "action_class": "irreversible"}');
    expect(mcpHint).toContain('{"name": "issues_list", "action_class": "read-only"}');
    expect(mcpHint).toContain('"server_dir": "./connectors/github/server"');
    const server = readFileSync(join(CONNECTORS_DIR, 'github', 'server', 'server.mjs'), 'utf8');
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
    expect(server).toContain('aegis-broker:8083');
  });

  it('caldav (C7): task_delete irreversible; сервер без Authorization', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'caldav', 'connector.json'), 'utf8'),
    ) as { config_hints: string[] };
    const mcpHint = meta.config_hints.find((h) => h.includes('"transport"')) ?? '';
    expect(mcpHint).toContain('{"name": "task_delete", "action_class": "irreversible"}');
    const server = readFileSync(join(CONNECTORS_DIR, 'caldav', 'server', 'server.mjs'), 'utf8');
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
    expect(server).toContain('aegis-broker:8084');
  });

  it('notion (C7): page_archive irreversible; сервер без Authorization', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'notion', 'connector.json'), 'utf8'),
    ) as { config_hints: string[] };
    const mcpHint = meta.config_hints.find((h) => h.includes('"transport"')) ?? '';
    expect(mcpHint).toContain('{"name": "page_archive", "action_class": "irreversible"}');
    const server = readFileSync(join(CONNECTORS_DIR, 'notion', 'server', 'server.mjs'), 'utf8');
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
    expect(server).toContain('aegis-broker:8085');
  });

  it('social (C13): post_publish irreversible; empty auth prefix; сервер без Authorization', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'social', 'connector.json'), 'utf8'),
    ) as { config_hints: string[]; broker_listener: { header_value_prefix: string; port: number } };
    expect(meta.broker_listener.port).toBe(8086);
    expect(meta.broker_listener.header_value_prefix).toBe('');
    const mcpHint = meta.config_hints.find((h) => h.includes('"transport"')) ?? '';
    expect(mcpHint).toContain('{"name": "post_publish", "action_class": "irreversible"}');
    expect(mcpHint).toContain('{"name": "post_draft", "action_class": "reversible"}');
    expect(mcpHint).toContain('"server_dir": "./connectors/social/server"');
    const server = readFileSync(join(CONNECTORS_DIR, 'social', 'server', 'server.mjs'), 'utf8');
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
    expect(server).toContain('aegis-broker:8086');
  });

  it('inbox-triage (C15): skill-only без broker_listener', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'inbox-triage', 'connector.json'), 'utf8'),
    ) as { broker_listener?: unknown; config_hints: string[] };
    expect(meta.broker_listener).toBeUndefined();
    expect(meta.config_hints.some((h) => h.includes('inbox-morning'))).toBe(true);
  });

  it('content-calendar (C16): skill-only weekly cron hint', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'content-calendar', 'connector.json'), 'utf8'),
    ) as { broker_listener?: unknown; config_hints: string[] };
    expect(meta.broker_listener).toBeUndefined();
    expect(meta.config_hints.some((h) => h.includes('content-calendar'))).toBe(true);
  });

  it('medialibrary (C17): 3 broker listeners, server without authorization', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'medialibrary', 'connector.json'), 'utf8'),
    ) as { broker_listeners: { port: number }[] };
    expect(meta.broker_listeners).toHaveLength(3);
    const server = readFileSync(join(CONNECTORS_DIR, 'medialibrary', 'server', 'server.mjs'), 'utf8');
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
  });

  it('bookmarks (C18): linkding listener :8090', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'bookmarks', 'connector.json'), 'utf8'),
    ) as { broker_listener: { port: number } };
    expect(meta.broker_listener.port).toBe(8090);
  });

  it('shopping-list (C19): skill-only без broker', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'shopping-list', 'connector.json'), 'utf8'),
    ) as { broker_listener?: unknown; broker_routes: unknown[] };
    expect(meta.broker_listener).toBeUndefined();
    expect(meta.broker_routes).toEqual([]);
  });

  it('google (C1): классы действий в hint — send строго irreversible', () => {
    const meta = JSON.parse(
      readFileSync(join(CONNECTORS_DIR, 'google', 'connector.json'), 'utf8'),
    ) as { config_hints: string[] };
    const mcpHint = meta.config_hints.find((h) => h.includes('"transport"')) ?? '';
    expect(mcpHint).toContain('{"name": "gmail_send", "action_class": "irreversible"}');
    expect(mcpHint).toContain('{"name": "gmail_draft", "action_class": "reversible"}');
    expect(mcpHint).toContain('{"name": "gmail_list", "action_class": "read-only"}');
    expect(mcpHint).toContain('{"name": "drive_list", "action_class": "read-only"}');
    expect(mcpHint).toContain('{"name": "gmail_finance_fetch", "action_class": "read-only"}');
    expect(mcpHint).toContain('{"name": "gmail_travel_fetch", "action_class": "read-only"}');
    expect(mcpHint).toContain('"server_dir": "./connectors/google/server"');
    // Сервер пресета существует и не выставляет Authorization по построению (V2):
    // ловим присваивание заголовка, комментарии со словом не в счёт.
    const server = readFileSync(join(CONNECTORS_DIR, 'google', 'server', 'server.mjs'), 'utf8');
    expect(/['"]?authorization['"]?\s*:/i.test(server)).toBe(false);
    expect(server).toContain('aegis-broker:8081');
  });
});
