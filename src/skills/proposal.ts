/**
 * F5: детектор повторов + draft-навыки из эпизодов (детерминированно, без LLM по умолчанию).
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { LearningConfig } from '../config/schema.ts';
import type { LlmClient } from '../llm/types.ts';
import type { EpisodeRow, EpisodeStore } from '../memory/episodes.ts';
import type { KnowledgeStore } from '../memory/knowledge.ts';
import type { PromotionGate } from '../memory/promotion.ts';
import type { SkillRegistry } from './registry.ts';
import { scanRejects } from './scanner.ts';
import {
  CAPABILITY_REGISTRY,
  type CapabilityId,
  type SkillManifest,
} from './types.ts';
import { validateManifestFile } from './validate.ts';

const CAP_SET = new Set<string>(CAPABILITY_REGISTRY);
const DRAFTS_DIR = '.drafts';

const COMMAND_CAPS: [RegExp, CapabilityId][] = [
  [/^\/fetch\b/, 'web.fetch'],
  [/^\/digest\b/, 'web.fetch'],
  [/^\/read\b/, 'files.read'],
  [/^\/write\b|^\/undo-file\b|^\/delete-file\b/, 'files.write'],
  [/^\/search\b|^\/summarize\b/, 'memory.read'],
  [/^\/remind\b/, 'schedule.manage'],
  [/^\/metrics\b|^\/status\b/, 'memory.read'],
];

export function episodeActionToken(content: string): string {
  const t = content.trim();
  for (const [re, cap] of COMMAND_CAPS) {
    if (re.test(t)) return cap;
  }
  const norm = t.toLowerCase().replace(/\s+/g, ' ').slice(0, 64);
  return norm.length > 0 ? `msg:${norm}` : 'msg:empty';
}

export function sessionSignature(rows: EpisodeRow[]): string {
  return rows
    .filter((r) => r.role === 'owner')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => episodeActionToken(r.content))
    .join('>');
}

export function capabilitiesFromSignature(signature: string): CapabilityId[] {
  const caps = new Set<CapabilityId>();
  for (const part of signature.split('>')) {
    if (CAP_SET.has(part)) caps.add(part as CapabilityId);
  }
  if (caps.size === 0) caps.add('memory.read');
  if ([...caps].some((c) => c !== 'memory.read')) caps.add('messages.send');
  return [...caps];
}

export function validateNeedsSubset(manifest: SkillManifest, allowed: CapabilityId[]): boolean {
  const allow = new Set(allowed);
  return manifest.needs.every((n) => allow.has(n));
}

function skillNameFromSignature(signature: string): string {
  const h = createHash('sha256').update(signature).digest('hex').slice(0, 8);
  return `repeat-${h}`;
}

function networkForNeeds(needs: CapabilityId[]): SkillManifest['network'] {
  if (needs.includes('web.fetch')) return ['aegis-broker'];
  if (needs.includes('messages.send')) return ['outbound'];
  return 'none';
}

function actionClassForNeeds(needs: CapabilityId[]): SkillManifest['action_class'] {
  if (needs.includes('files.write') || needs.includes('schedule.manage')) return 'reversible';
  return 'read-only';
}

export interface SkillProposalHit {
  signature: string;
  skillName: string;
  sessionIds: string[];
  count: number;
}

export interface SkillProposalRunnerOptions {
  skillsDir: string;
  threshold?: number;
  windowDays?: number;
  now?: () => number;
  llm?: LlmClient;
}

export class SkillProposalRunner {
  private readonly db: Database.Database;
  private readonly episodes: EpisodeStore;
  private readonly skillsDir: string;
  private readonly learning: LearningConfig;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly llm: LlmClient | undefined;

  constructor(
    db: Database.Database,
    episodes: EpisodeStore,
    learning: LearningConfig,
    opts: SkillProposalRunnerOptions,
  ) {
    this.db = db;
    this.episodes = episodes;
    this.skillsDir = opts.skillsDir;
    this.learning = learning;
    this.threshold = opts.threshold ?? 3;
    this.windowMs = (opts.windowDays ?? 14) * 24 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.llm = opts.llm;
  }

  detect(): SkillProposalHit[] {
    const since = this.now() - this.windowMs;
    const sessions = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM episodes WHERE role = 'owner' AND created_at >= ?`,
      )
      .all(since) as { session_id: string }[];

    const bySig = new Map<string, string[]>();
    for (const { session_id } of sessions) {
      const sig = sessionSignature(this.episodes.listBySession(session_id, 200));
      if (!sig || sig === 'msg:empty') continue;
      const list = bySig.get(sig) ?? [];
      list.push(session_id);
      bySig.set(sig, list);
    }

    const hits: SkillProposalHit[] = [];
    for (const [signature, sessionIds] of bySig) {
      if (sessionIds.length < this.threshold) continue;
      if (this.isSuppressed(signature)) continue;
      const existing = this.getProposal(signature);
      if (existing?.status === 'accepted' || existing?.status === 'proposed') continue;
      hits.push({
        signature,
        skillName: existing?.skill_name ?? skillNameFromSignature(signature),
        sessionIds,
        count: sessionIds.length,
      });
    }
    return hits;
  }

  async propose(hit: SkillProposalHit): Promise<string> {
    const caps = capabilitiesFromSignature(hit.signature);
    const samples = this.sampleEpisodes(hit.sessionIds);
    const { skillMd, manifest } = this.learning.self_improvement_llm_enabled && this.llm
      ? await this.generateWithLlm(hit, caps, samples)
      : this.buildDeterministicDraft(hit, caps, samples);

    const validation = validateManifestFile(
      manifest,
      join(this.draftsRoot(), hit.skillName),
      hit.skillName,
      skillMd,
    );
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    if (!validateNeedsSubset(manifest, caps)) {
      throw new Error('manifest requests capabilities not seen in episodes');
    }

    this.writeDraft(hit.skillName, skillMd, manifest);
    const scanErr = scanRejects(this.draftDir(hit.skillName));
    if (scanErr) {
      rmSync(this.draftDir(hit.skillName), { recursive: true, force: true });
      throw new Error(scanErr);
    }
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO skill_proposals (signature, skill_name, status, sample_session_ids, created_at, updated_at)
         VALUES (?, ?, 'proposed', ?, ?, ?)
         ON CONFLICT(signature) DO UPDATE SET
           skill_name = excluded.skill_name,
           status = 'proposed',
           sample_session_ids = excluded.sample_session_ids,
           updated_at = excluded.updated_at`,
      )
      .run(hit.signature, hit.skillName, JSON.stringify(hit.sessionIds), ts, ts);
    return hit.skillName;
  }

  async run(): Promise<string[]> {
    const created: string[] = [];
    for (const hit of this.detect()) {
      try {
        created.push(await this.propose(hit));
      } catch {
        /* skip invalid draft */
      }
    }
    return created;
  }

  draftsRoot(): string {
    return join(this.skillsDir, DRAFTS_DIR);
  }

  draftDir(name: string): string {
    return join(this.draftsRoot(), name);
  }

  listDraftNames(): string[] {
    const root = this.draftsRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((e) => {
      const p = join(root, e);
      return statSync(p).isDirectory() && existsSync(join(p, 'manifest.json'));
    });
  }

  readDraft(name: string): { skillMd: string; manifest: SkillManifest } | undefined {
    const dir = this.draftDir(name);
    if (!existsSync(join(dir, 'manifest.json'))) return undefined;
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as unknown;
    const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    return { skillMd, manifest: raw as SkillManifest };
  }

  accept(
    name: string,
    registry: SkillRegistry,
    knowledge: KnowledgeStore,
    promotion: PromotionGate,
  ): void {
    const draft = this.readDraft(name);
    if (!draft) throw new Error(`draft not found: ${name}`);
    const dest = join(this.skillsDir, name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    cpSync(this.draftDir(name), dest, { recursive: true });
    rmSync(this.draftDir(name), { recursive: true, force: true });
    registry.reload();

    let kid = knowledge.findSkillKnowledgeId(name);
    kid ??= knowledge.insertSkill({
      title: name,
      body: `Draft skill ${name} accepted by owner`,
      provenance: 'owner',
      skillRef: `draft://${name}`,
    });
    promotion.ownerCorroborate(kid);

    const row = this.db
      .prepare(`SELECT signature FROM skill_proposals WHERE skill_name = ?`)
      .get(name) as { signature: string } | undefined;
    if (row) {
      this.db
        .prepare(`UPDATE skill_proposals SET status = 'accepted', updated_at = ? WHERE signature = ?`)
        .run(this.now(), row.signature);
    }
  }

  reject(name: string): void {
    const row = this.db
      .prepare(`SELECT signature FROM skill_proposals WHERE skill_name = ?`)
      .get(name) as { signature: string } | undefined;
    if (existsSync(this.draftDir(name))) rmSync(this.draftDir(name), { recursive: true, force: true });
    if (row) {
      this.db
        .prepare(
          `UPDATE skill_proposals SET status = 'rejected', updated_at = ? WHERE signature = ?`,
        )
        .run(this.now(), row.signature);
      this.db
        .prepare(
          `INSERT INTO skill_proposal_suppressions (signature, suppressed_at) VALUES (?, ?)
           ON CONFLICT(signature) DO NOTHING`,
        )
        .run(row.signature, this.now());
    }
  }

  private writeDraft(name: string, skillMd: string, manifest: SkillManifest): void {
    const dir = this.draftDir(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8');
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  private buildDeterministicDraft(
    hit: SkillProposalHit,
    caps: CapabilityId[],
    samples: EpisodeRow[],
  ): { skillMd: string; manifest: SkillManifest } {
    const lines = samples
      .slice(0, 6)
      .map((e) => `- [${e.sessionId}] ${e.content.slice(0, 120)}`);
    const skillMd = `---
name: ${hit.skillName}
description: Auto-detected repeated task (${hit.count} sessions)
---

# ${hit.skillName}

Detected signature: \`${hit.signature}\`

## Sample episodes

${lines.join('\n')}
`;
    const manifest: SkillManifest = {
      schema_version: 1,
      name: hit.skillName,
      version: '0.1.0',
      needs: caps,
      network: networkForNeeds(caps),
      action_class: actionClassForNeeds(caps),
      code: false,
      entrypoints: [],
    };
    return { skillMd, manifest };
  }

  private async generateWithLlm(
    hit: SkillProposalHit,
    caps: CapabilityId[],
    samples: EpisodeRow[],
  ): Promise<{ skillMd: string; manifest: SkillManifest }> {
    const sampleText = samples
      .slice(0, 8)
      .map((e) => `[${e.role}] ${e.content.slice(0, 200)}`)
      .join('\n');
    const result = await this.llm!.complete({
      messages: [
        {
          role: 'system',
          content:
            'Write a declarative Agent Skill draft. Reply with JSON only: {"description":"...","procedure":"markdown body without frontmatter"}',
        },
        {
          role: 'user',
          content: `Task signature: ${hit.signature}\nAllowed capabilities only: ${caps.join(', ')}\nSamples:\n${sampleText}`,
        },
      ],
      maxTokens: 1024,
    });
    let procedure = result.message.content;
    try {
      const parsed = JSON.parse(result.message.content) as { description?: string; procedure?: string };
      procedure = parsed.procedure ?? procedure;
      const desc = parsed.description ?? `Repeated task ${hit.skillName}`;
      const skillMd = `---
name: ${hit.skillName}
description: ${desc}
---

${procedure}
`;
      const manifest: SkillManifest = {
        schema_version: 1,
        name: hit.skillName,
        version: '0.1.0',
        needs: caps,
        network: networkForNeeds(caps),
        action_class: actionClassForNeeds(caps),
        code: false,
        entrypoints: [],
      };
      return { skillMd, manifest };
    } catch {
      return this.buildDeterministicDraft(hit, caps, samples);
    }
  }

  private sampleEpisodes(sessionIds: string[]): EpisodeRow[] {
    const out: EpisodeRow[] = [];
    for (const sid of sessionIds.slice(0, 3)) {
      out.push(...this.episodes.listBySession(sid, 20));
    }
    return out;
  }

  private isSuppressed(signature: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM skill_proposal_suppressions WHERE signature = ?`)
      .get(signature);
  }

  private getProposal(signature: string): { skill_name: string; status: string } | undefined {
    return this.db
      .prepare(`SELECT skill_name, status FROM skill_proposals WHERE signature = ?`)
      .get(signature) as { skill_name: string; status: string } | undefined;
  }
}