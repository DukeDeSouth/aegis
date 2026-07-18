/**
 * L1 (Sprint 37): Q-LLM proposes merge plan; deterministic apply via PromotionGate.
 */
import { z } from 'zod';
import type { LlmClient, LlmUsage } from '../llm/types.ts';
import type { KnowledgeStore } from './knowledge.ts';
import type { PromotionGate } from './promotion.ts';
import type { MemorySnapshot } from './snapshot.ts';

const MAX_MERGES = 5;
const MAX_SUMMARY_BODY = 2048;

const mergeSchema = z
  .object({
    keep_id: z.number().int().positive(),
    refute_ids: z.array(z.number().int().positive()).min(1),
    summary_title: z.string().min(1).max(500),
    summary_body: z.string().min(1).max(MAX_SUMMARY_BODY),
  })
  .strict();

const planSchema = z.object({ merges: z.array(mergeSchema).max(MAX_MERGES) }).strict();

export type ConsolidationMerge = z.infer<typeof mergeSchema>;
export type ConsolidationPlan = z.infer<typeof planSchema>;

export interface ConsolidationResult {
  snapshotId: number;
  merged: number;
  newKnowledgeIds: number[];
  refuted: number;
  usage: LlmUsage;
}

export interface ConsolidationRunnerOptions {
  batchSize?: number;
  maxTokens?: number;
}

const SYSTEM_PROMPT =
  'You merge duplicate or related facts. Output ONLY valid JSON, no markdown.\n' +
  'Schema: {"merges":[{"keep_id":number,"refute_ids":[number],"summary_title":string,"summary_body":string}]}\n' +
  'Rules: refute_ids only from input ids; keep_id must appear in refute_ids; max 5 merges; if nothing to merge: {"merges":[]}';

export function parseConsolidationPlan(raw: string): ConsolidationPlan {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('CONSOLIDATION_ERROR: response is not JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error('CONSOLIDATION_ERROR: invalid JSON');
  }
  const result = planSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`CONSOLIDATION_ERROR: schema ${result.error.message}`);
  }
  return result.data;
}

export function validateConsolidationPlan(plan: ConsolidationPlan, batchIds: ReadonlySet<number>): void {
  const usedRefutes = new Set<number>();
  for (const merge of plan.merges) {
    if (!merge.refute_ids.includes(merge.keep_id)) {
      throw new Error('CONSOLIDATION_ERROR: keep_id must be in refute_ids');
    }
    for (const id of merge.refute_ids) {
      if (!batchIds.has(id)) {
        throw new Error(`CONSOLIDATION_ERROR: unknown knowledge id ${id}`);
      }
      if (usedRefutes.has(id)) {
        throw new Error(`CONSOLIDATION_ERROR: duplicate refute id ${id}`);
      }
      usedRefutes.add(id);
    }
  }
}

export class ConsolidationRunner {
  private readonly knowledge: KnowledgeStore;
  private readonly promotion: PromotionGate;
  private readonly snapshot: MemorySnapshot;
  private readonly qLlm: LlmClient;
  private readonly batchSize: number;
  private readonly maxTokens: number;

  constructor(
    knowledge: KnowledgeStore,
    promotion: PromotionGate,
    snapshot: MemorySnapshot,
    qLlm: LlmClient,
    opts: ConsolidationRunnerOptions = {},
  ) {
    this.knowledge = knowledge;
    this.promotion = promotion;
    this.snapshot = snapshot;
    this.qLlm = qLlm;
    this.batchSize = opts.batchSize ?? 25;
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async run(): Promise<ConsolidationResult> {
    const batch = this.knowledge.listForConsolidation(this.batchSize);
    if (batch.length < 2) {
      return {
        snapshotId: 0,
        merged: 0,
        newKnowledgeIds: [],
        refuted: 0,
        usage: { promptTokens: 0, completionTokens: 0, estimated: false },
      };
    }

    const snap = this.snapshot.create('pre-consolidation');
    const userPayload = JSON.stringify(
      batch.map((f) => ({ id: f.id, title: f.title, body: f.body })),
    );
    const llmResult = await this.qLlm.complete({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPayload },
      ],
      maxTokens: this.maxTokens,
    });

    const plan = parseConsolidationPlan(llmResult.message.content ?? '');
    const batchIds = new Set(batch.map((f) => f.id));
    validateConsolidationPlan(plan, batchIds);

    const newKnowledgeIds: number[] = [];
    let refuted = 0;
    for (const merge of plan.merges) {
      for (const id of merge.refute_ids) {
        this.promotion.refute(id, 'llm_consolidate', `merged into consolidation summary (keep #${merge.keep_id})`);
        refuted++;
      }
      const newId = this.knowledge.insert({
        title: merge.summary_title,
        body: merge.summary_body,
        provenance: 'consolidation',
        epistemicStatus: 'unverified',
      });
      this.promotion.addEvidence(
        newId,
        'llm_proposal',
        JSON.stringify({ sources: merge.refute_ids, snapshot_id: snap.id, keep_id: merge.keep_id }),
      );
      newKnowledgeIds.push(newId);
    }

    return {
      snapshotId: snap.id,
      merged: plan.merges.length,
      newKnowledgeIds,
      refuted,
      usage: llmResult.usage,
    };
  }
}
