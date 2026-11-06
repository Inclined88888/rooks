/**
 * Agent configuration — the type and its reading on disk, separate from the rest.
 *
 * Extracted from `agent.ts` to break the cycle `agent ↔ backends ↔
 * browser-sessions`: the backend dialects only needed the `AgentConfig`
 * TYPE, but importing it from `agent.ts` dragged along the whole spawn
 * engine. This module only depends on the file system and the paths.
 *
 * Verbatim move: nothing was renamed or retouched. `agent.ts`
 * re-exports everything that was public, no existing import moves.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_DIR, agentConfig, agentDir, agentSystemPrompt } from './paths.js';
import type { BackendName } from './backends/types.js';
import type { AgentRoleId } from './agent-roles.js';
import type { AgentAvatarMode, AgentLook } from './agent-look.js';

export type AgentConfig = {
  /** Manager of this agent — the single source of the agents hierarchy
   *  (graph, Company chart). Null/absent = the default: its project's lead,
   *  else its pole's lead, else the main agent (app/src/lib/hierarchy.ts).
   *  Written through PATCH /api/agents/:name/config, checked by
   *  `checkReportsTo` (existing agent, no cycle). */
  reports_to?: string | null;
  /**
   * Team id (`teams` table) for bots without a project. `null`/absent = agent
   * outside any team, i.e. the historical behaviour: it addresses and is
   * addressed by everyone. The cloisonnement only bites when the SENDER has a
   * team — see `sendAgentMessage`.
   */
  team?: string | null;
  cwd?: string;
  /** undefined inherits; null disables browsing; a profile id is an explicit,
   * owner-checked assignment frozen when each mission starts. */
  browser_profile_id?: string | null;
  /** DEFAULT LLM backend of the agent. 'claude' (default) = long-lived Claude
   *  CLI; 'codex' = one-shot OpenAI Codex CLI on the ChatGPT subscription.
   *  The agent is AGNOSTIC: this field is only a default, overridable per
   *  mission AND per task. Single resolution chain (symmetrical with model):
   *    backend = task.backend_override ?? roleSpec.backend ?? cfg.backend ?? 'claude'
   *    model   = task.model_override   ?? roleSpec.model   ?? cfg.model   ?? default(backend)
   *  → an Opus mission and a GPT-5.5 mission can run on the SAME agent
   *  in parallel (through mission.backend_override / fork) without touching this config. */
  backend?: BackendName;
  /** DEFAULT LLM model. Prefer an alias (`opus`/`sonnet` → follows the latest
   *  version) or a full slug (`gpt-5.5`). A default
   *  overridable per mission/task — see `backend`. Must stay consistent with
   *  `backend` (a claude-* slug on the codex backend is ignored by the dispatcher). */
  model?: string;
  /** Reasoning level ("low", "medium", "high", "xhigh"). Passed to the codex
   *  CLI through -c model_reasoning_effort=<value>. null = the model's default. */
  reasoningEffort?: string | null;
  permission_mode?: string;
  allowed_tools?: string[];
  /** Tool name patterns passed to claude via --disallowedTools. We compute
   *  this at spawn time from the set of external (claude.ai) MCPs the user
   *  has *not* enabled for this agent — but the user can also append manual
   *  entries. */
  disallowed_tools?: string[];
  /**
   * @deprecated Checked skills are agent-scope attachments (`skill-attachments.ts`).
   * No longer read by the spawn or the agent views: a config.json written by an
   * older Timon (imported, restored) only yields its skills when the next boot or
   * write moves them to attachments (`agent-skills-migration.ts`, `absorbConfigSkills`).
   * Sent on a write, it is the agent's whole checked set and never stored here.
   */
  skills?: string[];
  /** TIMON-managed MCP server ids attached to this agent (stdio/http only).
   *  Externals are enabled by default — see excluded_mcp_servers below. */
  mcp_servers?: string[];
  /** External (claude.ai) MCP ids that the user has explicitly *disabled*
   *  for this agent. Inverted because externals load by default from the
   *  user's claude.ai account — toggling one off means "block its tools
   *  via --disallowedTools for this agent". */
  excluded_mcp_servers?: string[];
  /**
   * Project slug. If absent, we auto-derive it from `cwd` (first segment
   * under /workspace/). Use it to group agents across the UI and to scope
   * sub-agent spawns to the same project.
   */
  project?: string;
  /**
   * Memory persistence strategy for this agent:
   *   NONE    – no memory dir injected (default)
   *   SESSION – per-mission dir, created at spawn, deleted at mission_complete
   *   AGENT   – per-agent persistent dir (~/.timon/agents/<name>/memory/)
   *   GLOBAL  – shared across all agents (~/.timon/memory/)
   */
  memory_scope?: 'NONE' | 'SESSION' | 'AGENT' | 'GLOBAL';
  /**
   * Marker: this agent is ephemeral and will be destroyed at the end of its mission.
   * Its config + its system prompt live in `~/.timon/agents/_eph-<uuid>/`
   * (same layout as normal agents, simplifies all the downstream code),
   * but the folder is purged on `proc.exit` when the last mission
   * completes. Protected field: only `createEphemeralAgent` can set it —
   * `upsertAgent` and `patchAgentConfig` strip it silently to
   * prevent a privilege escalation through POST/PATCH /api/agents. */
  ephemeral?: boolean;
  /**
   * Business role of the agent (coder, reviewer, librarian, ops, orchestrator).
   * Determines the pictogram shown in the UI AND injects a block of default
   * directives into the system prompt. See `agent-roles.ts` for the registry.
   */
  role?: AgentRoleId;
  /**
   * Free extra custom directives. Concatenated after the role's
   * default directives in the system prompt. Allows adapting
   * a generic role to a specific project/context without touching the
   * `system-prompt.md`.
   */
  directives?: string;
  /** Visual identity: emoji (1-4 chars) shown in the canvas, the
   *  chat header, and the active-agents strip instead of the fallback
   *  based on the name's hash.
   *  @deprecated replaced by the role's pictogram (`role`). Kept for the
   *  existing configs — the UI no longer offers editing it. */
  emoji?: string;
  /** Accent colour (hex `#RRGGBB`, `hsl(...)`, or any valid CSS
   *  value). Replaces the auto palette for the avatar / the
   *  stroke of the canvas node.
   *  @deprecated the visual identity now comes from the project — kept
   *  for the existing configs. */
  color?: string;
  /** Mascot look drawn when the agent has no picture (`icon_url`). Checked
   *  against the mascot's own lists (`agent-look.ts`) on every write; a value
   *  edited by hand that fails the check reads back as no look. */
  look?: AgentLook;
  /** Which head the agent shows: `emoji`, `image` (`icon_url`) or `mascot`
   *  (`look`). Absent = the historical order (picture, project logo, emoji,
   *  initial). Choosing one keeps the settings of the others. */
  avatar?: AgentAvatarMode;
  /** Optional URL of a logo. When defined, the UI can use it
   *  instead of the emoji/initial (highest priority).
   *  @deprecated see `color`. */
  icon_url?: string;
  /**
   * Role marker: this agent has the right to spawn ephemeral agents
   * (or more generally, to use the orchestrator-only tools).
   * `_main` has it by default (hardcoded on the permission check side); any other
   * agent must declare it explicitly. Protected field: `upsertAgent`
   * and `patchAgentConfig` strip it — granted only by editing the
   * config.json on disk directly (local admin), never through the API.
   */
  orchestrator?: boolean;
  /**
   * Whom this agent may delegate to (`mission_spawn`, `timon spawn`, Kanban
   * tasks assigned to another agent): a list of agent names, or `'*'` for
   * everybody. Absent = derived (`agent-orchestration.ts`): everybody for the
   * main agent and for an `orchestrator` (flag or role), otherwise the agents
   * below it in the `reports_to` tree. `[]` = nobody. Protected key like
   * `orchestrator`: it is a delegation right, so an agent that could write it
   * through the API would grant itself the run of the fleet — it is written by
   * `PUT /api/agents/:name/orchestrates` (operator only), not by the config
   * routes.
   */
  orchestrates?: string[] | '*';
  /**
   * Injects the CROSS-PROJECT DIGEST (hot projects + objectives) into the system
   * prompt at spawn. Conditioned on the flag — NOT on `project == null` — so that a
   * project-less business agent (priority orchestration) as well as a project agent
   * can have it. Assembled without an LLM from the `projects` table + the knowledge vault
   * front-matter. Default false. Editable through the UI (PATCH allow-list).
   */
  global_context?: boolean;
  /**
   * Who created the agent when it was not a person: `plugin:<id>` for an agent
   * made through `ctx.agents.create`. Protected key — only that facade writes
   * it (`plugins/agent-origin.ts`), so a plugin may later update the agents it
   * made, and only those, and its uninstall can name them.
   */
  created_by?: string;
};

/**
 * Privileged flags never let in through the public paths
 * (POST /api/agents, PATCH /api/agents/:name/config, upsertAgent,
 * patchAgentConfig). Without this filter, any HTTP caller could
 * hoist itself to the orchestrator role and trigger ephemeral spawns, or
 * get itself purged automatically at the end of a mission.
 *
 * Set internally by `createEphemeralAgent` (ephemeral) or by manual
 * editing of the config.json on disk (orchestrator for a custom agent).
 */
const PROTECTED_CONFIG_KEYS = ['ephemeral', 'orchestrator', 'orchestrates', 'created_by'] as const;


export function stripProtectedKeys(cfg: AgentConfig): AgentConfig {
  const out: AgentConfig = { ...cfg };
  for (const k of PROTECTED_CONFIG_KEYS) {
    delete (out as Record<string, unknown>)[k];
  }
  return out;
}

/** Resolves an agent name to the EXACT name of its on-disk folder,
 *  CASE-INSENSITIVELY. On Linux the FS is case-sensitive, so a task
 *  created for `timon.main` did not find the real agent `TIMON.main` → spawn
 *  failing with "Missing system prompt" → BLOCKED in a loop. We canonicalise at the
 *  resolution point: if the folder exists as is → fast path; otherwise AGENTS_DIR
 *  is scanned for a case-insensitive match and the real name is returned; otherwise the
 *  name is returned unchanged (lets the clear error come up for a real unknown,
 *  and keeps the literal name for the CREATION of a new agent). */
export function canonicalAgentName(name: string): string {
  if (existsSync(agentDir(name))) return name; // already the right case
  const lower = name.toLowerCase();
  try {
    for (const entry of readdirSync(AGENTS_DIR)) {
      if (entry.toLowerCase() === lower) return entry;
    }
  } catch { /* AGENTS_DIR missing: nothing to canonicalise */ }
  return name;
}

export function loadConfig(agentName: string): AgentConfig {
  const path = agentConfig(canonicalAgentName(agentName));
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;
}

export function loadSystemPrompt(agentName: string): string {
  const path = agentSystemPrompt(canonicalAgentName(agentName));
  if (!existsSync(path)) {
    throw new Error(`Missing system prompt for agent "${agentName}" at ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * `SOUL.md` — the agent's own identity, written by the user rather than by
 * Timon: who it is, what it is for, how it should behave. Kept apart from
 * `system-prompt.md`, which carries the technical instructions Timon seeds and
 * which onboarding must never overwrite.
 *
 * Read case-insensitively because the file is offered under that exact name in
 * the UI, and a user-created `soul.md` is the same intent.
 */
export function loadSoul(agentName: string): string {
  const dir = agentDir(canonicalAgentName(agentName));
  if (!existsSync(dir)) return '';
  try {
    const file = readdirSync(dir).find((entry) => entry.toLowerCase() === 'soul.md');
    return file ? readFileSync(join(dir, file), 'utf8').trim() : '';
  } catch { return ''; }
}

/** One identity doc is sent up to this size: a note pasted whole must not
 *  swallow the context window of every mission of the agent. */
const IDENTITY_DOC_CAP = 32 * 1024;

/**
 * The agent's other `.md` files (`charter.md`, `rules.md`, `style.md`…): notes
 * the user wrote about who the agent is, sent to the model after `SOUL.md`.
 * `system-prompt.md` and `SOUL.md` have their own place in the prompt and are
 * left out. Alphabetical, so the order does not depend on the filesystem.
 */
export function loadIdentityDocs(agentName: string): { name: string; content: string; truncated: boolean }[] {
  const dir = agentDir(canonicalAgentName(agentName));
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^[\w.-]+\.md$/.test(d.name)
        && d.name.toLowerCase() !== 'system-prompt.md' && d.name.toLowerCase() !== 'soul.md')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .flatMap((name) => {
        const text = readFileSync(join(dir, name), 'utf8').trim();
        if (!text) return [];
        const truncated = text.length > IDENTITY_DOC_CAP;
        return [{ name, content: truncated ? text.slice(0, IDENTITY_DOC_CAP) : text, truncated }];
      });
  } catch { return []; }
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function validName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid agent name: ${name}`);
}
