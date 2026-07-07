/**
 * E2E Sprint 17 / F7: импорт SKILL.md-only навыков.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';
import { SkillInstaller } from '../../src/skills/installer.ts';
import { importExternalSkill } from '../../src/skills/import.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import {
  EXTERNAL_FIXTURES_DIR,
  writeExternalFixtures,
} from '../fixtures/external-skills/setup.ts';

const root = mkdtempSync(join(tmpdir(), 'aegis-skill-import-loop-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => writeExternalFixtures());

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('skill import loop (F7)', () => {
  it('scanner blocks risky code skill', () => {
    const r = importExternalSkill(join(EXTERNAL_FIXTURES_DIR, 'ext-risky-shell'));
    expect(r.requiresReview).toBe(true);
    const memoryDb = openDb(join(root, 'risk.db'));
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    const installer = new SkillInstaller({
      skillsDir: join(root, 'sk'),
      registry: new SkillRegistry(join(root, 'sk')),
      knowledge: new KnowledgeStore(memoryDb),
    });
    expect(() =>
      installer.installFromDir(join(EXTERNAL_FIXTURES_DIR, 'ext-risky-shell'), 'fixture://risk'),
    ).toThrow(/scanner rejected/);
  });

  it('/skill-approve activates imported skill in prompt', async () => {
    const skillsDir = join(root, 'skills-active');
    const memoryDb = openDb(join(root, 'act.db'));
    const queueDb = openDb(join(root, 'q.db'));
    const auditDb = openDb(join(root, 'a.db'));
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const registry = new SkillRegistry(skillsDir);
    const knowledge = new KnowledgeStore(memoryDb);
    const promotion = new PromotionGate(memoryDb);
    const installer = new SkillInstaller({ skillsDir, registry, knowledge });
    const imported = installer.installFromDir(
      join(EXTERNAL_FIXTURES_DIR, 'ext-vague'),
      'fixture://ext-vague',
    );
    expect(imported.requiresReview).toBe(true);

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000 });
    const audit = new AuditLog(auditDb);
    const pending = new PendingStore(queueDb);
    let captured = '';
    const llm: LlmClient = {
      complete(req): Promise<LlmResult> {
        captured = req.messages.find((m) => m.role === 'system')?.content ?? '';
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const orch = new Orchestrator(queues, audit, llm, pending, {
      skills: registry,
      knowledge,
      promotion,
    });

    queues.publish('inbound', JSON.stringify({ text: 'hi', session_id: 'tg:1' }), 'owner');
    await orch.processOne();
    expect(captured).not.toContain('ext-vague');

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/skill-approve ${imported.name}`, session_id: 'tg:1' }),
      'owner',
    );
    await orch.processOne();

    queues.publish('inbound', JSON.stringify({ text: 'hi again', session_id: 'tg:1' }), 'owner');
    await orch.processOne();
    expect(captured).toContain('ext-vague');
  });
});
