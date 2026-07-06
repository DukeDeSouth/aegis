/**
 * Dry-run код-навыка в sandbox → promotion corroborated (Sprint 8).
 */
import type { PromotionGate } from '../memory/promotion.ts';
import type { KnowledgeStore } from '../memory/knowledge.ts';
import type { SandboxRunner } from '../sandbox/types.ts';
import type { SkillRegistry } from './registry.ts';
import type { DryRunResult } from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_BYTES = 128 * 1024 * 1024;

export interface SkillDryRunOptions {
  registry: SkillRegistry;
  sandbox: SandboxRunner;
  promotion: PromotionGate;
  knowledge: KnowledgeStore;
  timeoutMs?: number;
  memoryBytes?: number;
}

export class SkillDryRun {
  private readonly registry: SkillRegistry;
  private readonly sandbox: SandboxRunner;
  private readonly promotion: PromotionGate;
  private readonly knowledge: KnowledgeStore;
  private readonly timeoutMs: number;
  private readonly memoryBytes: number;

  constructor(opts: SkillDryRunOptions) {
    this.registry = opts.registry;
    this.sandbox = opts.sandbox;
    this.promotion = opts.promotion;
    this.knowledge = opts.knowledge;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryBytes = opts.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  }

  async run(skillName: string): Promise<DryRunResult> {
    const manifest = this.registry.getManifest(skillName);
    const skillDir = this.registry.getSkillDir(skillName);
    if (!manifest || !skillDir) {
      throw new Error(`skill not found: ${skillName}`);
    }
    if (!manifest.code) {
      throw new Error(`skill ${skillName} is declarative (no dry-run)`);
    }
    const entrypoint = manifest.entrypoints[0];
    if (!entrypoint) throw new Error(`skill ${skillName} has no entrypoints`);

    const allowedHosts = manifest.network === 'none' ? [] : manifest.network;
    const result = await this.sandbox.run(skillDir, entrypoint, {
      timeoutMs: this.timeoutMs,
      memoryBytes: this.memoryBytes,
      allowedHosts,
    });

    let knowledgeId = this.knowledge.findSkillKnowledgeId(skillName);
    knowledgeId ??= this.knowledge.insertSkill({
      title: skillName,
      body: `Code skill ${skillName}`,
      provenance: 'owner',
      skillRef: `local://${skillName}`,
    });

    let corroborated = false;
    if (result.exitCode === 0 && !result.timedOut) {
      this.promotion.corroborateWithEvidence(knowledgeId, 'test_pass', 'dry-run passed');
      this.registry.markCorroborated(skillName);
      corroborated = true;
    }

    return {
      skillName,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      corroborated,
      knowledgeId,
    };
  }
}
