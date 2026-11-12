/**
 * Read-only view of everything Rooks injects into an agent at spawn, in the order
 * it reaches the model.
 *
 * The blocks come from `buildPromptSegments`, the very function `spawnTurn`
 * concatenates into the system prompt: the view cannot drift from the spawn,
 * and a test pins that the blocks joined are the prompt byte for byte.
 *
 * What the view does NOT claim: what the backend CLI loads by itself. Which files
 * a CLI reads (AGENTS.md, CLAUDE.md, user-level or parent-folder files, imports)
 * and where they land is decided by that CLI, differs per backend, and is not
 * computed by the spawn — so nothing here could be measured. Those files are
 * listed last as candidates (`injected_by: 'cli'`): their presence in the working
 * folder is a fact, their being read is not.
 *
 * Two rules that matter more than the shape:
 *  - a secret the vault knows is masked in every block, and a masked block is
 *    never editable — saving the `***` it shows would overwrite the real text.
 *    That masks the view, not the prompt: the model gets the value as written,
 *    outside the one case `sent_masked` names;
 *  - an edit target names the real source (agent file, memory rule, skill,
 *    role, agent config), never a copy held by this view.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  buildPromptSegments, buildSkillsBlock, loadConfig, parseExtraSkills, skillPastedContent, skillPromptContent, skillPromptPiece,
  skillsBlockHeadings,
  type AgentConfig, type PromptSegment,
} from './agent.js';
import { draftExcludedSkills, SKILL_MODES, type AgentSkillsDraft, type SkillMode, type SkillVia as PromptSkillVia } from './skill-attachments.js';
import { listSkills, readSkillsContent } from './skills.js';
import { listSkillFiles, remoteSkillFiles } from './skill-files.js';
import { canonicalAgentName } from './agent-config.js';
import { backendCapabilities, getBackend } from './backends/index.js';
import { DEFAULT_BACKEND_CAPABILITIES } from './backends/types.js';
import { agentConfig, agentDir, GLOBAL_INSTRUCTIONS_FILE, skillFile } from './paths.js';
import { readGlobalInstructions } from './global-instructions.js';
import { redactText } from './secrets/redact.js';
import { estimateTokens } from './summary.js';

/** Where an edit must be written: one of the routes that already own the source. */
export const editTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent_file'), agent: z.string(), path: z.string() }),
  z.object({ kind: z.literal('global_instructions') }),
  z.object({ kind: z.literal('agent_config'), agent: z.string(), field: z.literal('directives') }),
  z.object({ kind: z.literal('agent_role'), role_id: z.string() }),
  z.object({ kind: z.literal('memory_rule'), rule_id: z.number().int() }),
  z.object({ kind: z.literal('skill'), skill_id: z.string() }),
]);
export type EditTarget = z.infer<typeof editTargetSchema>;

/** Which part of the product a block comes from, for the badge that traces it. */
export const injectionOriginSchema = z.enum(['rooks', 'user', 'agent', 'memory', 'skills', 'project']);
export type InjectionOrigin = z.infer<typeof injectionOriginSchema>;

const ORIGIN_OF: Record<InjectionBlock['source'], InjectionOrigin> = {
  preamble: 'rooks',
  backend: 'rooks',
  'global-digest': 'rooks',
  'global-instructions': 'user',
  soul: 'agent',
  docs: 'agent',
  role: 'agent',
  directives: 'agent',
  'system-prompt': 'agent',
  memory: 'memory',
  skills: 'skills',
  'project-file': 'project',
};

const itemSchema = z.object({
  id: z.string(),
  label: z.string(),
  content: z.string(),
  /** Estimated tokens of `content`. */
  tokens: z.number().int(),
  /** The file this text lives in, when it has one. */
  source_path: z.string().nullable(),
  editable: z.boolean(),
  editable_text: z.string().nullable(),
  edit_target: editTargetSchema.nullable(),
  /** A skill entry: pasted whole (`import`) or one catalogue line (`include`). */
  skill_mode: z.enum(['include', 'import']).nullable().default(null),
  /** Where that skill comes from: an attachment scope, or the code. */
  skill_via: z.enum(['global', 'project', 'role', 'agent', 'code']).nullable().default(null),
  /** Attached to the catalogue, but pasted whole: this backend has no way to read a skill on demand. */
  skill_promoted: z.boolean().default(false),
  /** A catalogue skill: what reading its body with `skill_get` costs, paid only if the agent reads it. */
  on_demand_tokens: z.number().int().nullable().default(null),
});

export const injectionBlockSchema = z.object({
  id: z.string(),
  /** Which layer of Rooks (or of the CLI) writes this block. */
  source: z.enum([
    'preamble', 'backend', 'global-instructions', 'soul', 'docs', 'role', 'directives', 'global-digest',
    'memory', 'system-prompt', 'skills', 'project-file',
  ]),
  origin: injectionOriginSchema,
  /** The file this block is read from, when it has one (code-made blocks have none). */
  source_path: z.string().nullable(),
  /** Estimated tokens of `content` (~4 chars per token; each backend counts its own way). */
  tokens: z.number().int(),
  /** Who puts it in front of the model. `cli` = a candidate only: the backend CLI MAY read it from the working directory; its position is not measured. */
  injected_by: z.enum(['rooks', 'cli']),
  order: z.number().int(),
  label: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  /** A vault secret was masked in `content`. */
  redacted: z.boolean(),
  /** That secret is masked in what the model receives too (`buildSkillsBlock`); otherwise only this view hides it. */
  sent_masked: z.boolean().default(false),
  editable: z.boolean(),
  /** The raw source text to load in an editor, when it differs from `content`. */
  editable_text: z.string().nullable(),
  edit_target: editTargetSchema.nullable(),
  items: z.array(itemSchema),
});
export type InjectionBlock = z.infer<typeof injectionBlockSchema>;

export const injectionsResponseSchema = z.object({
  agent: z.string(),
  backend: z.string(),
  blocks: z.array(injectionBlockSchema),
  /** Length of the system prompt Rooks hands the backend. */
  prompt_chars: z.number().int(),
  /** Estimated tokens of that system prompt: what is sent before the first message. */
  prompt_tokens: z.number().int(),
  /** What reading every catalogue skill would add, on top: information only, never part of `prompt_tokens`. */
  on_demand_tokens: z.number().int().default(0),
});
export type InjectionsResponse = z.infer<typeof injectionsResponseSchema>;

/** A project file is shown up to this size; the CLI reads it whole. */
const FILE_CAP = 64 * 1024;
/** Instruction files some backend CLIs pick up from the working directory on
 *  their own; listed whatever the backend, since Rooks cannot tell which one does. */
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

type Masked = { content: string; redacted: boolean };
function mask(text: string): Masked {
  const content = redactText(text);
  return { content, redacted: content !== text };
}

function soulFile(agent: string): string | null {
  const dir = agentDir(agent);
  if (!existsSync(dir)) return null;
  try { return readdirSync(dir).find((f) => f.toLowerCase() === 'soul.md') ?? null; } catch { return null; }
}

type Draft = Omit<InjectionBlock, 'order' | 'content' | 'redacted' | 'sent_masked' | 'editable_text' | 'editable' | 'items' | 'origin' | 'tokens'> & {
  raw: string;
  /** Raw text an editor loads, if not `raw`. */
  editable_raw?: string;
  editable: boolean;
  items?: {
    id: string; label: string; raw: string; editable_raw?: string; source_path?: string; edit_target: EditTarget | null;
    skill_mode?: SkillMode; skill_via?: PromptSkillVia; skill_promoted?: boolean; on_demand_tokens?: number;
    /** Already masked by the prompt: `raw` no longer shows it, and the editor text may still hold the value. */
    masked?: boolean;
  }[];
};

function draftsFor(agent: string, seg: PromptSegment): Draft[] {
  const base = { truncated: false, injected_by: 'rooks' as const, source_path: null };
  switch (seg.id) {
    case 'preamble':
      return [{ ...base, id: 'preamble', source: 'preamble', label: 'ROOKS preamble', raw: seg.body, editable: false, edit_target: null }];
    case 'backend':
      return [{ ...base, id: 'backend', source: 'backend', label: 'LLM backend', raw: seg.body, editable: false, edit_target: null }];
    case 'global-instructions': {
      return [{
        ...base, id: 'global-instructions', source: 'global-instructions', label: 'Global instructions', raw: seg.body,
        source_path: GLOBAL_INSTRUCTIONS_FILE,
        // What the editor loads is the file, not the heading Rooks puts on it.
        editable_raw: readGlobalInstructions(),
        editable: true, edit_target: { kind: 'global_instructions' },
      }];
    }
    case 'soul': {
      const file = soulFile(agent);
      return [{
        ...base, id: 'soul', source: 'soul', label: 'SOUL.md', raw: seg.body,
        source_path: file ? join(agentDir(agent), file) : null,
        editable_raw: seg.body.replace(/^# Who you are\n\n/, '').replace(/\n$/, ''),
        editable: file !== null,
        edit_target: file ? { kind: 'agent_file', agent, path: file } : null,
      }];
    }
    case 'docs':
      return [{
        ...base, id: 'docs', source: 'docs', label: 'Identity docs', raw: seg.body, editable: false, edit_target: null,
        items: (seg.docs ?? []).map((d) => ({
          id: `doc-${d.name}`, label: d.name, raw: d.content, source_path: join(agentDir(agent), d.name),
          edit_target: { kind: 'agent_file' as const, agent, path: d.name },
        })),
      }];
    case 'role':
      return [{
        ...base, id: 'role', source: 'role', label: `Role: ${seg.role?.label ?? ''}`, raw: seg.body,
        editable_raw: seg.body.replace(/^\n?# Role: .*\n\n/, '').replace(/\n$/, ''),
        // A built-in role's directives are editable too (and resettable): the
        // route takes `default_directives` for both kinds.
        editable: seg.role !== undefined,
        edit_target: seg.role ? { kind: 'agent_role', role_id: seg.role.id } : null,
      }];
    case 'directives':
      return [{
        ...base, id: 'directives', source: 'directives', label: 'Custom directives', raw: seg.body,
        source_path: agentConfig(agent),
        editable_raw: loadConfig(agent).directives ?? '',
        editable: true, edit_target: { kind: 'agent_config', agent, field: 'directives' },
      }];
    case 'global-digest':
      return [{ ...base, id: 'global-digest', source: 'global-digest', label: 'Cross-project digest', raw: seg.body, editable: false, edit_target: null }];
    case 'memory':
      return [{
        ...base, id: 'memory', source: 'memory', label: 'Memory', raw: seg.body, editable: false, edit_target: null,
        items: [
          ...(seg.rules ?? []).map((r) => ({
            id: `memory-rule-${r.id}`,
            label: `${r.scope}${r.tier === 'core' ? ' · core' : ''}`,
            raw: r.text,
            edit_target: { kind: 'memory_rule' as const, rule_id: r.id },
          })),
          ...(seg.pitfalls ?? []).map((text, i) => ({ id: `memory-pitfall-${i}`, label: 'pitfall', raw: text, edit_target: null })),
        ],
      }];
    case 'system-prompt':
      return [{
        ...base, id: 'system-prompt', source: 'system-prompt', label: 'system-prompt.md', raw: seg.body,
        source_path: join(agentDir(agent), 'system-prompt.md'),
        editable: true, edit_target: { kind: 'agent_file', agent, path: 'system-prompt.md' },
      }];
    case 'skills':
      return [{
        ...base, id: 'skills', source: 'skills', label: 'Skills', raw: seg.body, editable: false, edit_target: null,
        items: (seg.skills ?? []).map((s) => {
          // What is shown (a catalogue line, a body without its frontmatter) is
          // not the file: the editor loads the whole SKILL.md, or nothing.
          let full: string | undefined;
          try { full = readFileSync(skillFile(s.id), 'utf8'); } catch { full = undefined; }
          return {
            id: `skill-${s.id}`, label: s.id, raw: s.content, editable_raw: full, source_path: skillFile(s.id),
            edit_target: full !== undefined ? { kind: 'skill' as const, skill_id: s.id } : null,
            skill_mode: s.mode, skill_via: s.via, skill_promoted: s.promoted === true, masked: s.masked === true,
            on_demand_tokens: s.mode === 'include' && full !== undefined ? estimateTokens(skillGetText(s.id, full)) : undefined,
          };
        }),
      }];
  }
}

function projectFileDrafts(cwd: string | undefined): Draft[] {
  if (!cwd) return [];
  const out: Draft[] = [];
  for (const name of PROJECT_FILES) {
    const file = join(cwd, name);
    try {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, 'utf8');
      const truncated = text.length > FILE_CAP;
      out.push({
        id: `project-file-${name}`, source: 'project-file', injected_by: 'cli', label: name, source_path: file,
        raw: truncated ? text.slice(0, FILE_CAP) : text, truncated,
        // Read by the CLI, not owned by the agent: no route of the agent
        // editor writes into a project's working tree.
        editable: false, edit_target: null,
      });
    } catch { /* absent: nothing injected */ }
  }
  return out;
}

/** The fields of a mission row that change what its prompt says. */
export type MissionOverrides = {
  backend_override: string | null;
  model_override: string | null;
  /** Skills the code added to this mission's spawn (pasted whole). */
  extra_skills?: string | null;
};

/**
 * The injections of an agent, in order. `missionText` is what the memory recall
 * matches against at spawn; empty shows the mission-independent part (core
 * rules, then the most recent).
 */
export function buildInjections(
  agentName: string,
  missionText = '',
  mission: MissionOverrides | null = null,
): InjectionsResponse {
  const agent = canonicalAgentName(agentName);
  const cfg = loadConfig(agent);
  // The same overrides the spawn applies before it builds the prompt: a mission
  // can run another backend or model than the agent's own.
  if (mission?.backend_override) cfg.backend = mission.backend_override as typeof cfg.backend;
  if (mission?.model_override) cfg.model = mission.model_override;
  // A display, not a launch: an agent whose provider is gone still shows its prompt.
  let backend: ReturnType<typeof getBackend>;
  try { backend = getBackend(cfg.backend); } catch { backend = getBackend(undefined); }
  const segments = buildPromptSegments(agent, cfg, backend, missionText, parseExtraSkills(mission?.extra_skills));
  const drafts = [...segments.flatMap((s) => draftsFor(agent, s)), ...projectFileDrafts(cfg.cwd)];
  const blocks = drafts.map((d, i): InjectionBlock => {
    const shown = mask(d.raw);
    const items = (d.items ?? []).map((it) => {
      const m = mask(it.raw);
      const editable = it.edit_target !== null && !m.redacted && !it.masked;
      return {
        id: it.id, label: it.label, content: m.content,
        // A skill weighs what it adds to the block, its glue included: the
        // agent editor sums the same pieces (`skillWeights`).
        tokens: estimateTokens(it.skill_mode ? skillPromptPiece(it.label, it.skill_mode, m.content) : m.content),
        source_path: it.source_path ?? null, editable,
        editable_text: editable ? (it.editable_raw ?? it.raw) : null,
        edit_target: it.edit_target,
        skill_mode: it.skill_mode ?? null,
        skill_via: it.skill_via ?? null,
        skill_promoted: it.skill_promoted === true,
        on_demand_tokens: it.on_demand_tokens ?? null,
      };
    });
    const itemsRedacted = (d.items ?? []).some((it) => it.masked || mask(it.raw).redacted);
    const sentMasked = !shown.redacted && (d.items ?? []).some((it) => it.masked);
    const editable = d.editable && !shown.redacted;
    return {
      id: d.id, source: d.source, origin: ORIGIN_OF[d.source], source_path: d.source_path,
      injected_by: d.injected_by, order: i + 1, label: d.label,
      content: shown.content, tokens: estimateTokens(shown.content), truncated: d.truncated, redacted: shown.redacted || itemsRedacted,
      sent_masked: sentMasked,
      editable,
      editable_text: editable ? (d.editable_raw ?? d.raw) : null,
      edit_target: d.edit_target,
      items,
    };
  });
  const prompt = segments.map((s) => s.text).join('');
  const onDemand = blocks.flatMap((b) => b.items).reduce((sum, it) => sum + (it.on_demand_tokens ?? 0), 0);
  return injectionsResponseSchema.parse({
    agent, backend: backend.name, blocks, prompt_chars: prompt.length,
    prompt_tokens: estimateTokens(prompt),
    on_demand_tokens: onDemand,
  });
}

/** What `skill_get` hands the agent (`mcp-tools-agents.mjs`): the id, then the whole SKILL.md, vault values masked. */
function skillGetText(id: string, file: string): string {
  const files = listSkillFiles(id).map((entry) => `\`${entry.path}\``);
  const trailer = files.length > 0 ? `\n\n---\nFiles next to this SKILL.md: ${files.join(', ')}. Read one with skill_get (id, file).` : '';
  return redactText(`skill: ${id}\n\n${file}${trailer}`);
}

export const skillWeightSchema = z.object({
  /** Tokens at every spawn when the skill is in the catalogue: its line. */
  include: z.number().int(),
  /** Tokens at every spawn when the skill is imported: its body, pasted whole. */
  import: z.number().int(),
  /** Tokens a `skill_get` of it costs, paid only when the agent reads it. */
  on_demand: z.number().int(),
  /** Tokens for a remote backend: the body and eligible neighbour files. */
  pasted: z.number().int(),
  /** Neighbour files a remote backend cannot receive. */
  left_out: z.array(z.string()),
});
export type SkillWeight = z.infer<typeof skillWeightSchema>;

export const skillWeightsResponseSchema = z.object({
  weights: z.record(z.string(), skillWeightSchema),
  headings: z.object({ include: z.number().int(), import: z.number().int() }),
});
export type SkillWeightsResponse = z.infer<typeof skillWeightsResponseSchema>;

/** A backend with no way to read a skill on demand. */
const REMOTE_CAPS = { ...DEFAULT_BACKEND_CAPABILITIES, novaMcp: false, attachments: false };

/**
 * The weight of each Rooks skill in each mode, measured on the very text the
 * spawn puts in the skills block (`skillPromptContent` / `skillPromptPiece`):
 * what the agent editor shows on each box. The total is `buildSkillsPreview`'s.
 */
export function skillWeights(): SkillWeightsResponse {
  const weights: Record<string, SkillWeight> = {};
  for (const { id, content } of readSkillsContent(listSkills().map((s) => s.id))) {
    const of = (mode: SkillMode) => estimateTokens(skillPromptPiece(id, mode, redactText(
      mode === 'import' ? skillPastedContent(id, content) : skillPromptContent(id, mode, content))));
    weights[id] = {
      include: of('include'), import: of('import'), on_demand: estimateTokens(skillGetText(id, content)),
      pasted: estimateTokens(skillPromptPiece(id, 'import', redactText(skillPastedContent(id, content, REMOTE_CAPS)))),
      // A name can hold a vault value, as in `buildSkillsPreview`.
      left_out: remoteSkillFiles(id).left_out.map((entry) => redactText(entry.path)),
    };
  }
  const headings = skillsBlockHeadings();
  return skillWeightsResponseSchema.parse({
    weights,
    headings: { include: estimateTokens(headings.include), import: estimateTokens(headings.import) },
  });
}

/** The unsaved fields of the agent editor that change what a spawn sends, as a save would write them. */
export type SkillsPreviewDraft = {
  skills: AgentSkillsDraft;
  role?: string;
  project?: string;
  cwd?: string;
  backend?: string;
  model?: string;
  global_context?: boolean;
  system_prompt?: string;
};

export const skillsPreviewResponseSchema = z.object({
  agent: z.string().nullable(),
  /** The skills the prompt would carry, as the spawn resolves them. */
  skills: z.array(z.object({
    id: z.string(),
    mode: z.enum(SKILL_MODES),
    via: z.enum(['global', 'project', 'role', 'agent', 'code']),
    /** Estimated tokens it adds to the block, once the skills before it have drawn on the prompt's file budget. */
    tokens: z.number().int(),
    /** Neighbour files the prompt names as not sent, for the same reason; `skillWeights` measures a skill alone. */
    left_out: z.array(z.string()),
  })),
  /** Checked in the draft, yet kept out by the agent's own exclusion. */
  excluded: z.array(z.string()),
  /** Estimated tokens of the skills block. */
  skills_tokens: z.number().int(),
  /** What reading every catalogue skill would add, never part of `prompt_tokens`. */
  on_demand_tokens: z.number().int(),
  /** Estimated tokens of the whole prompt; null for an agent not created yet, which has none. */
  prompt_tokens: z.number().int().nullable(),
});
export type SkillsPreviewResponse = z.infer<typeof skillsPreviewResponseSchema>;

/**
 * What a spawn would send once the editor's draft is saved, resolved by the
 * spawn's own code rather than recomputed by the client: exclusions and
 * attachments of every scope apply, and the total is the prompt's own. Writes
 * nothing. `agent` null is an agent not created yet: no agent-scope row, no
 * files of its own, so only its skills block can be measured.
 */
export function buildSkillsPreview(agent: string | null, draft: SkillsPreviewDraft): SkillsPreviewResponse {
  const name = agent ? canonicalAgentName(agent) : '';
  const cfg: AgentConfig = agent ? loadConfig(name) : {};
  // The same fields `save()` sends: empty means "not set", which a save writes as absent.
  if (draft.cwd !== undefined) cfg.cwd = draft.cwd || undefined;
  if (draft.project !== undefined) cfg.project = draft.project.trim() || undefined;
  if (draft.role !== undefined) cfg.role = draft.role;
  if (draft.model !== undefined) cfg.model = draft.model || undefined;
  if (draft.backend !== undefined) cfg.backend = (draft.backend || undefined) as AgentConfig['backend'];
  if (draft.global_context !== undefined) cfg.global_context = draft.global_context;

  let block: string;
  let skills: NonNullable<PromptSegment['skills']>;
  let promptTokens: number | null = null;
  let backend: ReturnType<typeof getBackend>;
  try { backend = getBackend(cfg.backend); } catch { backend = getBackend(undefined); }
  if (agent) {
    const segments = buildPromptSegments(name, cfg, backend, '', [], { skills: draft.skills, systemPrompt: draft.system_prompt });
    const segment = segments.find((s) => s.id === 'skills');
    block = segment?.body ?? '';
    skills = segment?.skills ?? [];
    promptTokens = estimateTokens(segments.map((s) => s.text).join(''));
  } else {
    ({ block, skills } = buildSkillsBlock(name, cfg, [], backendCapabilities(backend.name), draft.skills));
  }
  return skillsPreviewResponseSchema.parse({
    agent: agent ? name : null,
    skills: skills.map((s) => ({
      id: s.id, mode: s.mode, via: s.via,
      tokens: estimateTokens(skillPromptPiece(s.id, s.mode, mask(s.content).content)),
      left_out: (s.left_out ?? []).map((path) => mask(path).content),
    })),
    excluded: agent ? draftExcludedSkills(name, draft.skills) : [],
    skills_tokens: estimateTokens(mask(block).content),
    on_demand_tokens: skills.reduce((sum, s) => {
      if (s.mode !== 'include') return sum;
      try { return sum + estimateTokens(skillGetText(s.id, readFileSync(skillFile(s.id), 'utf8'))); } catch { return sum; }
    }, 0),
    prompt_tokens: promptTokens,
  });
}
