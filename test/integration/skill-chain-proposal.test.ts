/**
 * E2E Sprint 35 / L3: chain repeat → draft → accept.
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

const root = mkdtempSync(join(tmpdir(), 'aegis-chain-proposal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = 1_750_000_000_000;

function migration(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function seedChainSessions(episodes: EpisodeStore, sid: string): void {
  episodes.append(sid, 'owner', '/digest', 'owner');
  episodes.append(sid, 'owner', '/write reports/weekly.md | draft body', 'owner');
}

describe('skill chain proposal loop (L3)', () => {
  it('/curate proposes composite draft from repeated command chain', async () => {
    const skillsDir = join(root, 'skills-chain');
    const memoryDb = openDb(join(root, 'mem-chain.db'));
    const queueDb = openDb(join(root, 'q-chain.db'));
    const auditDb = openDb(join(root, 'a-chain.db'));
    applyMigration(memoryDb, migration('0001-memory.sql'), 1);
    applyMigration(memoryDb, migration('0006-memory.sql'), 6);
    applyMigration(queueDb, migration('0001-queue.sql'), 1);
    applyMigration(auditDb, migration('0001-audit.sql'), 1);

    const episodes = new EpisodeStore(memoryDb, { now: () => NOW });
    for (const sid of ['c1', 'c2', 'c3']) seedChainSessions(episodes, sid);

    const knowledge = new KnowledgeStore(memoryDb, { now: () => NOW });
    const promotion = new PromotionGate(memoryDb, { now: () => NOW });
    const snapshot = new MemorySnapshot(memoryDb, join(root, 'mem-chain.db'), join(root, 'snap-chain'));
    const curation = new CurationRunner(memoryDb, knowledge, promotion, snapshot);
    const proposals = new SkillProposalRunner(memoryDb, episodes, {
      self_improvement_llm_enabled: false,
      min_reuse_rate: 0,
      skill_proposal_threshold: 3,
      skill_proposal_window_days: 14,
      skill_chain_detection_enabled: true,
      skill_chain_min_length: 2,
      skill_chain_max_length: 3,
      skill_curator_stale_days: 30,
      skill_curator_min_success_rate: 0.5,
    }, { skillsDir, threshold: 3, windowDays: 14, now: () => NOW });
    const registry = new SkillRegistry(skillsDir);
    const queues = new QueueStore(queueDb);
    const audit = new AuditLog(auditDb, { now: () => NOW });
    const pending = new PendingStore(queueDb);
    const llm: LlmClient = {
      complete: async (): Promise<LlmResult> => ({
        message: { role: 'assistant', content: 'ok' },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      }),
    };
    const orch = new Orchestrator(queues, audit, llm, pending, {
      episodes,
      knowledge,
      promotion,
      curation,
      skillProposals: proposals,
      skills: registry,
    });

    queues.publish('inbound', JSON.stringify({ session_id: 'tg:1', text: '/curate' }), 'owner');
    await orch.processOne();

    const draftNames = proposals.listDraftNames();
    expect(draftNames.length).toBe(1);
    const name = draftNames[0]!;
    const draft = proposals.readDraft(name);
    expect(draft?.skillMd).toContain('Procedure (auto-detected chain)');
    expect(draft?.skillMd).toContain('/digest');
    expect(registry.list().some((s) => s.name === name)).toBe(false);

    queues.publish(
      'inbound',
      JSON.stringify({ session_id: 'tg:1', text: `/skill-accept ${name}` }),
      'owner',
    );
    await orch.processOne();
    expect(existsSync(join(skillsDir, name, 'manifest.json'))).toBe(true);
  });
});
