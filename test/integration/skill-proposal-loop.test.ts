/**
 * E2E Sprint 15 / F5: propose → review → accept.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/host/audit/log.ts';
import { PendingStore } from '../../src/host/gate/pending.ts';
import { Orchestrator } from '../../src/host/orchestrator/loop.ts';
import { QueueStore } from '../../src/host/queue/store.ts';
import type { LlmClient, LlmResult } from '../../src/llm/types.ts';
import { applyMigration, openDb } from '../../src/memory/db.ts';
import { EpisodeStore } from '../../src/memory/episodes.ts';
import { KnowledgeStore } from '../../src/memory/knowledge.ts';
import { PromotionGate } from '../../src/memory/promotion.ts';
import { CurationRunner } from '../../src/memory/curation.ts';
import { MemorySnapshot } from '../../src/memory/snapshot.ts';
import { SkillProposalRunner } from '../../src/skills/proposal.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';

const root = mkdtempSync(join(tmpdir(), 'aegis-proposal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;
const SIG_TEXT = 'check weekly report';

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('skill proposal loop (F5)', () => {
  it('/curate proposes draft; accept installs skill', async () => {
    const skillsDir = join(root, 'skills');
    const memoryDb = openDb(join(root, 'mem.db'));
    const queueDb = openDb(join(root, 'q.db'));
    const auditDb = openDb(join(root, 'a.db'));
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(memoryDb, migration('0006-memory.sql'), 6);
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const episodes = new EpisodeStore(memoryDb, { now: () => NOW });
    for (const sid of ['s1', 's2', 's3']) {
      episodes.append(sid, 'owner', SIG_TEXT, 'owner');
    }

    const knowledge = new KnowledgeStore(memoryDb, { now: () => NOW });
    const promotion = new PromotionGate(memoryDb, { now: () => NOW });
    const snapshot = new MemorySnapshot(memoryDb, join(root, 'mem.db'), join(root, 'snap'));
    const curation = new CurationRunner(memoryDb, knowledge, promotion, snapshot, {
      now: () => NOW,
    });
    const registry = new SkillRegistry(skillsDir);
    const proposals = new SkillProposalRunner(
      memoryDb,
      episodes,
      {
        self_improvement_llm_enabled: false,
        min_reuse_rate: 0,
        skill_proposal_threshold: 3,
        skill_proposal_window_days: 14,
        skill_curator_stale_days: 30,
        skill_curator_min_success_rate: 0.5,
      },
      { skillsDir, threshold: 3, now: () => NOW },
    );

    const queues = new QueueStore(queueDb, { visibilityTimeoutMs: 30_000, now: () => NOW });
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb, { now: () => NOW });
    const llm: LlmClient = {
      complete(): Promise<LlmResult> {
        return Promise.resolve({
          message: { role: 'assistant', content: 'ok' },
          usage: { promptTokens: 1, completionTokens: 1, estimated: false },
        });
      },
    };
    const orch = new Orchestrator(queues, audit, llm, pending, {
      episodes,
      knowledge,
      promotion,
      curation,
      skills: registry,
      skillProposals: proposals,
    });

    queues.publish('inbound', JSON.stringify({ text: '/curate', session_id: 'tg:1' }), 'owner');
    await orch.processOne();
    const out1 = queues.claim('outbound', 't');
    expect(out1?.payload).toContain('/skill-review');
    if (out1) queues.ack(out1.id);

    const draftName = proposals.listDraftNames()[0];
    expect(draftName).toBeDefined();
    expect(existsSync(join(skillsDir, '.drafts', draftName!, 'SKILL.md'))).toBe(true);
    expect(registry.has(draftName!)).toBe(false);

    queues.publish(
      'inbound',
      JSON.stringify({ text: `/skill-accept ${draftName}`, session_id: 'tg:1' }),
      'owner',
    );
    await orch.processOne();
    registry.reload();
    expect(registry.has(draftName!)).toBe(true);
    expect(existsSync(join(skillsDir, '.drafts', draftName!))).toBe(false);
  });
});
