/**
 * Automatic creation of a project's child agents.
 *
 * Unification rule: a project `<slug>` has one agent per role. WHO holds the
 * role is DATA (the agent's `config.role`, or roles.json pinning), not
 * a reading of its name: a project's reviewer may be called
 * `Jean-Pierre`. `<slug>.<role>` is now only a naming default, used
 * when nobody holds the role — the agent is then seeded here.
 *
 * Before this module, the dispatcher used the MERE existence of a
 * `<slug>.<role>` folder as the criterion: a folder created without `system-prompt.md`
 * (the TIMON.merger case) made every spawn fail in a silent loop. We
 * now materialise the complete agent (config.json + system-prompt.md) instead
 * of presuming it is well-formed.
 *
 * Idempotent: an existing agent is NEVER overwritten (manual
 * customisations are respected). Only what is entirely missing is seeded.
 */
import { existsSync } from 'node:fs';
import { agentDir } from './paths.js';
import { upsertAgent, type AgentConfig } from './agent.js';
import { getAgent, listAgents } from './agent.js';
import { loadConfig } from './agent-config.js';
import { dbApi } from './db.js';
import { mainAgentName, projectOrchestratorName } from './main-agent.js';
import { asBackendName, backendForModel } from './backends/index.js';
import { oneShotProviderIds } from './backends/registry.js';
import { catalogClaimsModel } from './backends/catalog.js';
import { baseBackendId } from './backends/instance-id.js';
import { missionOverrideAuthority, taskOverrideRefusal } from './users/privileged-overrides.js';

/** Roles that have a dedicated child agent managed by convention. `doc` is excluded:
 *  doc tasks are always assigned to TIMON.librarian by doc-task.ts. */
export const CONVENTION_ROLES = new Set(['coder', 'reviewer', 'merger', 'researcher', 'ops']);

/** Task type → role the agent running it must hold. The role's name and
 *  the type's only half match (`code` → `coder`, `chore` →
 *  `ops`), hence this table — shared by the dispatcher and the project routes,
 *  which each had their own copy. */
export function roleForTaskType(type: string): string {
  const map: Record<string, string> = {
    code: 'coder', review: 'reviewer', merge: 'merger', research: 'researcher', chore: 'ops',
  };
  return map[type] ?? type;
}

/** `name` is the agent being seeded — it is NOT always `<slug>.<role>`: a
 *  project can pin any agent to a role, and its prompt must call it by the
 *  name it actually carries. */
type RoleDefaults = { model: string; permissionMode: string; prompt: (slug: string, name: string) => string };

const NO_COAUTHOR = 'No "Claude" / "Anthropic" / "Codex" / "Co-Authored-By" mention in commits.';

const ROLE_DEFAULTS: Record<string, RoleDefaults> = {
  coder: {
    model: 'opus',
    permissionMode: 'auto',
    prompt: (slug, name) => `You are \`${name}\`, the code/editing executor of project \`${slug}\`.

## Context
- You receive \`code\` (or \`chore\`) tasks from the TIMON Kanban.
- The dispatcher puts you in a dedicated git worktree (branch \`timon/task/<id>\`).

## Style
- Concise, in the language the user writes in. No final recap.
- Implement, commit cleanly, hand back with a short status through \`timon task done --comment\`.

## Hard rules
- You do not leave your worktree / cwd.
- Read a file before touching it. No opportunistic refactor outside the scope.
- Blocked (ambiguity, product decision) → \`timon task block --reason "..."\`, the orchestrator will escalate.
- ${NO_COAUTHOR}`,
  },
  reviewer: {
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto',
    prompt: (slug, name) => `You are \`${name}\`, the reviewer of the branches produced by the coder of project \`${slug}\`.

## Context
- You receive \`review\` tasks that follow a \`code\` task (deps). You read the branch diff against its base.

## Style
- Concise, in the language the user writes in. Comment ONLY on real problems (security, correctness, major performance). No nits, no "good job".

## Hard rules
- You do not modify the code. You only comment.
- **You ALWAYS close with \`timon task done\`**, never \`timon task block\`: the verdict is carried by the done_comment, parsed by the verification loop (coder respawned on \`changes_requested\`, automatic merge on \`pass\`). A \`block\` breaks the chain.
- done_comment format — **first line in plain text REQUIRED** (the only carrier of the verdict, survives any truncation): \`verdict: pass\` or \`verdict: changes_requested\`. Optional details as JSON on the following lines: \`{"findings": ["..."], "suggested_fixes": "..."}\`.
- Long comment → pass it with \`--comment-file PATH\` or \`--comment-stdin < PATH\` (redirected stdin, never a pipe), never as a huge inline shell argument (quoting can truncate the JSON and break the verdict parse).`,
  },
  merger: {
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto',
    prompt: (slug, name) => `You are \`${name}\`, who merges the review-approved branches of project \`${slug}\` into the base (\`main\`).

## Approach
1. Identify the source branch (\`timon/task/<id>\`) and the base.
2. Merge cleanly (merge/rebase), resolve conflicts thoughtfully (never a blind \`--theirs\`/\`--ours\`).
3. Check that the build/typecheck passes before finishing.
4. Close with \`timon task done --comment "merged into main (sha <SHA>)"\`.

## Hard rules
- **NEVER rebuild/restart the orchestrator**: you run under it, you would kill yourself mid-merge (orphan task). It is a separate ops step — report it in your done_comment instead of running it.
- Non-trivial conflict / broken build / branch not found → \`timon task block --reason "..."\` (no force). The orchestrator will escalate.
- ${NO_COAUTHOR}`,
  },
  researcher: {
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto',
    prompt: (slug, name) => `You are \`${name}\`, the investigation/planning agent of project \`${slug}\`.

## Context
- You receive \`research\` tasks: investigate, plan, compare options — without modifying the code.

## Style
- Concise, in the language the user writes in. Produce an actionable deliverable (a short 3-5 step plan, or a clear summary) in your done_comment.

## Hard rules
- You do not modify the code (read-only). Close with \`timon task done --comment\`.`,
  },
  ops: {
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto',
    prompt: (slug, name) => `You are \`${name}\`, the ops/maintenance agent of project \`${slug}\`.

## Context
- You receive \`chore\` tasks: cleanup, scripts, assorted operations work.

## Style
- Concise, in the language the user writes in. Close with \`timon task done --comment\` and a short status.

## Hard rules
- Stay within the requested scope. Destructive or ambiguous operation → \`timon task block --reason "..."\`.
- ${NO_COAUTHOR}`,
  },
};

/**
 * A project's orchestrator: not a Kanban role (`CONVENTION_ROLES` leaves it
 * out, no task is ever dispatched to it), but the agent the project's coder,
 * reviewer and merger report to. Seeded with the project by the onboarding
 * tour (`ensureProjectOrchestrator`).
 */
ROLE_DEFAULTS.orchestrator = {
  model: 'opus',
  permissionMode: 'auto',
  prompt: (slug, name) => `You are \`${name}\`, the orchestrator of the project \`${slug}\`.

## Your job
- You do not code yourself: you split the work into Kanban tasks for the project's agents (coder, reviewer, merger), follow them and report back.
- You answer the user, and the main agent when it delegates work on this project to you.

## Style
- Concise. Speak the user's language.

## Hard rules
- Read before you act; ask when a product decision is ambiguous.
- Never rebuild or restart Timon yourself: give the commands to the user.`,
};

/** Partial spec of a project role (subset of RoleSpec from projects.ts).
 *  Typed inline to avoid a needless cross import. */
type RoleSpecLike = {
  agent?: string | null;
  backend?: string | null;
  model?: string | null;
  permission_mode?: string | null;
};

/** The backend + model a seeded agent should run on when nothing more specific
 *  decides: those of whoever asked for the work. */
export type InheritedLlm = { backend: string; model: string | null };

/** True when `model` can run on `backend`: the catalogue claims it, or no
 *  backend claims it at all (a custom slug). A model another backend owns is
 *  what the CLI would crash on (`codex --model claude-opus-*`). */
function modelFits(backend: string | null, model: string): boolean {
  if (!backend) return true;
  return catalogClaimsModel(backend, model) || !backendForModel(model);
}

/**
 * Backend + model of the mission that created a task — the orchestrator the
 * work is done for. `null` when it is unknown OR when it is the default
 * backend left implicit: nothing to inherit then, the seed's Claude defaults
 * are already the right answer.
 *
 * Read from the mission first (`backend_override` is what a switch to another
 * backend writes), then from its agent's own config. The mission's model only
 * counts for the mission's own backend: an agent's `model` belongs to the
 * backend of its config, not to an override laid on top of it.
 */
export function llmOfMission(missionId: string | null | undefined): InheritedLlm | null {
  if (!missionId) return null;
  const mission = dbApi.getMission(missionId);
  if (!mission) return null;
  let cfg: AgentConfig = {};
  try { cfg = loadConfig(mission.agent_name); } catch { /* agent deleted since */ }
  const backend = asBackendName(mission.backend_override) ?? asBackendName(cfg.backend);
  if (!backend) return null;
  const sameBackend = !mission.backend_override || mission.backend_override === cfg.backend;
  const model = mission.model_override ?? (sameBackend ? cfg.model : null) ?? null;
  return { backend, model: model && modelFits(backend, model) ? model : null };
}

/**
 * The LLM a seeded agent may copy from the mission that created a task: what
 * `llmOfMission` reads, judged by the override policy against the authority of
 * the account that mission acts as — the same gate (`taskOverrideRefusal`) an
 * explicit `backend_override` on the task would have passed (TIM-0082).
 *
 * Only the creator the task STORES is read, and the route stores a mission
 * only when it is the authenticated caller's own (or named by an unrestricted
 * caller): the agent a task is assigned to is not a source, it is not the
 * provenance of anyone's choice. A refused pair is `null` — the seed falls back
 * on the role's own defaults, never on another mission.
 */
export function inheritedLlm(creatorMissionId: string | null | undefined): InheritedLlm | null {
  const llm = llmOfMission(creatorMissionId);
  if (!llm || !creatorMissionId) return null;
  // The template provider's family is the status quo and what the seed already does: there is
  // no privilege in it, and its account instances are not catalogue entries.
  if (isTemplateBackend(llm.backend)) return llm;
  const refusal = taskOverrideRefusal(
    { backend_override: llm.backend },
    null,
    missionOverrideAuthority(creatorMissionId),
  );
  return refusal ? null : llm;
}

/**
 * True for the provider the product's templates are written for (the one that declared the daemon's
 * own tasks as its job, C5 `oneShot`) and its account instances: the seeded agents' model tiers are its.
 */
export function isTemplateBackend(backend: string | null | undefined): boolean {
  return !backend || oneShotProviderIds().includes(baseBackendId(backend));
}

/**
 * The agent a task NAMES, when it should be run as named instead of being
 * remapped to the role's holder (TIM-0082). A user who tells their pilot to
 * "use the agents already in place" has chosen that agent; sending the task to
 * a freshly seeded Claude one ignored the choice.
 *
 * Honoured only when the name is an existing agent OF THIS PROJECT (an agent of
 * another project would run the task in the wrong repository) and is not:
 *   - a standing orchestrator (the main agent, the project's legacy
 *     `<slug>.main`) or the task's own creator — pilots assign tasks to
 *     themselves all the time, and the role system exists to catch that;
 *   - the holder of ANOTHER convention role (a `reviewer` named on a `code`
 *     task is a slip, not a choice).
 * An agent created without a role is stamped `orchestrator` (`upsertAgent`), so
 * that role alone cannot be a reason to refuse: it is what every agent a pilot
 * created by hand carries.
 */
export function honouredNamedAgent(
  slug: string,
  role: string,
  named: string | null | undefined,
  avoid: ReadonlyArray<string | null | undefined> = [],
): string | null {
  const verdict = judgeNamedAgent(slug, role, named, avoid);
  return 'agent' in verdict ? verdict.agent : null;
}

/**
 * Why the agent a task names was not honoured. TIM-0109: a tester counted 12
 * tasks out of 186 run by another agent than the one assigned, and nothing
 * said which rule had decided.
 */
export type NamedAgentRefusal =
  | 'missing'       // no such agent
  | 'other_project' // its `config.project` is not the task's project
  | 'orchestrator'  // the main agent, `<slug>.main` or the task's creator
  | 'other_role';   // it holds another convention role

function judgeNamedAgent(
  slug: string,
  role: string,
  named: string | null | undefined,
  avoid: ReadonlyArray<string | null | undefined>,
): { agent: string } | { refusal: NamedAgentRefusal; heldRole?: string } {
  if (!named || !existsSync(agentDir(named))) return { refusal: 'missing' };
  const agent = getAgent(named);
  if (!agent) return { refusal: 'missing' };
  if ((agent.project ?? '').toLowerCase() !== slug.toLowerCase()) return { refusal: 'other_project' };
  const lowered = named.toLowerCase();
  const standing = [mainAgentName(), `${slug}.main`, ...avoid];
  if (standing.some((a) => a && a.toLowerCase() === lowered)) return { refusal: 'orchestrator' };
  const heldRole = (agent.role ?? '').toLowerCase();
  if (heldRole && heldRole !== role.toLowerCase() && CONVENTION_ROLES.has(heldRole)) {
    return { refusal: 'other_role', heldRole };
  }
  return { agent: agent.name };
}

/**
 * The agent of project `slug` that HOLDS role `role`, read from the data
 * (`config.project` + `config.role`) and not from its name.
 *
 * That is what allows calling a project's reviewer `Jean-Pierre`: the
 * role is a field, the name is only a label. Case tolerated on both
 * sides — an agent often carries its project's capitalised slug.
 *
 * Several candidates: the choice must be STABLE from one dispatch to the next,
 * otherwise two tasks of the same pipeline go to two different agents. The
 * convention name wins if it is among them (it is the one the seed created),
 * otherwise the first in alphabetical order.
 */
export function agentHoldingRole(slug: string, role: string): string | null {
  const wanted = role.toLowerCase();
  const matches = listAgents().filter(
    (a) => (a.project ?? '').toLowerCase() === slug.toLowerCase()
      && (a.role ?? '').toLowerCase() === wanted,
  );
  if (matches.length === 0) return null;
  const conventional = `${slug}.${role}`.toLowerCase();
  return (
    matches.find((a) => a.name.toLowerCase() === conventional)
    ?? [...matches].sort((a, b) => a.name.localeCompare(b.name))[0]!
  ).name;
}

/** Inputs shared by `previewRoleAgent` and `resolveRoleAgent`. */
type RoleAgentOpts = {
  cwd?: string | null;
  spec?: RoleSpecLike;
  /** Agent the task is assigned to, honoured when it qualifies (cf. step 2). */
  named?: string | null;
  /** Agents never honoured as `named`, on top of the main orchestrator (the
   *  task's creator, who assigns work to itself). */
  avoid?: ReadonlyArray<string | null | undefined>;
  /** What a seed copies when no spec decides: the creator's backend + model. */
  inherit?: InheritedLlm | null;
};

/**
 * Who would hold the role, WITHOUT creating anything. Same arbitration as
 * {@link resolveRoleAgent} — which calls it — but readable from a
 * GET route: showing "the `review` tasks go to Jean-Pierre" must
 * not seed an agent along the way.
 *
 * `source` says where the answer comes from: `pinned` (roles.json), `named` (the task
 * names an agent of the project), `role` (an agent of the project holds the role),
 * `convention` (nobody: this name will be created at the first task).
 */
export function previewRoleAgent(
  slug: string,
  role: string,
  spec?: RoleSpecLike,
  opts: Pick<RoleAgentOpts, 'named' | 'avoid'> = {},
): RoleAgentPreview | null {
  if (!CONVENTION_ROLES.has(role)) return null;
  const pinned = spec?.agent?.trim();
  const verdict = pinned || !opts.named ? null : judgeNamedAgent(slug, role, opts.named, opts.avoid ?? []);
  const named = verdict && 'agent' in verdict ? verdict.agent : null;
  const held = pinned || named || agentHoldingRole(slug, role);
  const agent = held || `${slug}.${role}`;
  // Only a name that differs from the outcome was overridden.
  const overridden = !!opts.named && opts.named.toLowerCase() !== agent.toLowerCase();
  return {
    agent,
    source: pinned ? 'pinned' : named ? 'named' : held ? 'role' : 'convention',
    exists: existsSync(agentDir(agent)),
    ...(overridden && pinned ? { refusal: 'pinned' as const } : {}),
    ...(overridden && verdict && 'refusal' in verdict
      ? { refusal: verdict.refusal, ...(verdict.heldRole ? { heldRole: verdict.heldRole } : {}) }
      : {}),
  };
}

export type RoleAgentPreview = {
  agent: string;
  source: 'pinned' | 'named' | 'role' | 'convention';
  exists: boolean;
  /** Set when the task named another agent: why that one does not run it. */
  refusal?: NamedAgentRefusal | 'pinned';
  /** The convention role the named agent holds, for `other_role`. */
  heldRole?: string;
};

/**
 * Resolves the child agent for a (slug, role) pair AND guarantees it exists.
 * Single source of truth shared by the dispatcher (on-the-fly resolution
 * of a task) and the verification-loop (naming of the auto-generated
 * review/merge tasks):
 *   1. roles.json pinning `spec.agent` if it is defined, OTHERWISE
 *   2. the agent the task names (`opts.named`), if it is an existing agent of the
 *      project that is neither an orchestrator nor the holder of another role, OTHERWISE
 *   3. the project's agent that already holds this role, whatever its name, OTHERWISE
 *   4. the `<slug>.<role>` convention, which is then seeded.
 *
 * Step 3 is what brought the naming constraint down. Before it, a
 * project whose reviewer was called `Jean-Pierre` saw its `review` tasks
 * go to a `<slug>.reviewer` **created for the occasion**: the agent named
 * by hand was ignored, and an empty duplicate appeared in the grid. The
 * convention name is now only a naming default for a project that has
 * nobody on this role yet.
 *
 * Step 2 (TIM-0082) is the same idea on the task side: a pilot that names an
 * existing agent chose it, remapping it to a Claude agent seeded for
 * the occasion bypassed that choice.
 *
 * Returns the resolved name, or null if the role is outside the convention (hence not
 * self-managed, e.g. `doc`).
 */
export function resolveRoleAgent(
  slug: string,
  role: string,
  opts: RoleAgentOpts,
): string | null {
  return resolveRoleAgentPreview(slug, role, opts)?.agent ?? null;
}

/** {@link resolveRoleAgent}, with the reason of the choice (TIM-0109). */
export function resolveRoleAgentPreview(
  slug: string,
  role: string,
  opts: RoleAgentOpts,
): RoleAgentPreview | null {
  const preview = previewRoleAgent(slug, role, opts.spec, opts);
  if (!preview) return null;
  // An agent already holding the role exists: nothing to seed, it is addressed as
  // is. `ensureProjectAgent` never overwrites, but calling it here
  // would resurrect an agent deleted in the meantime under its old name.
  if (preview.source !== 'convention' && preview.exists) return preview;
  ensureProjectAgent(preview.agent, {
    slug,
    role,
    cwd: opts.cwd ?? null,
    backend: opts.spec?.backend ?? null,
    model: opts.spec?.model ?? null,
    permissionMode: opts.spec?.permission_mode ?? null,
    inherit: opts.inherit ?? null,
  });
  return preview;
}

/**
 * Guarantees a project child agent exists; seeds it if missing.
 * - `name`: canonical name (roles.json `agent` or the `<slug>.<role>` convention).
 * - `role`: role suffix (coder/reviewer/merger/researcher/ops) → picks the template.
 * - `backend` / `model`: those of the project role (roles.json), with priority.
 * - `inherit`: backend + model of the orchestrator asking for the work,
 *   used as a fallback. Without either, the agent is a Claude agent, with the
 *   template's model — the historical default, not a choice made for the
 *   person whose orchestrator runs on another backend (TIM-0082).
 * Returns true if the agent exists (already present or seeded), false if it
 * could not be created (unknown role, missing cwd).
 */
export function ensureProjectAgent(
  name: string,
  opts: {
    slug: string;
    role: string;
    cwd?: string | null;
    backend?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    inherit?: InheritedLlm | null;
  },
): boolean {
  if (existsSync(agentDir(name))) return true;
  const defaults = ROLE_DEFAULTS[opts.role];
  if (!defaults) {
    console.warn(`[agent-seed] unknown role "${opts.role}" for ${name} — no template, seed skipped`);
    return false;
  }
  if (!opts.cwd) {
    console.warn(`[agent-seed] missing cwd for ${name} — cannot seed (host path required)`);
    return false;
  }
  const backend = asBackendName(opts.backend) ?? asBackendName(opts.inherit?.backend) ?? null;
  // The template's models are the template provider's tiers (opus for the coder, a cheaper one
  // for the reviewer): they apply to its family only. On any other
  // backend the inherited model, or none — the backend's own default — stands
  // in; writing `opus` next to `backend: codex` is what the dispatcher would
  // then have to discard.
  const candidates = [opts.model, isTemplateBackend(backend) ? defaults.model : opts.inherit?.model];
  const model = candidates.find((m): m is string => !!m && modelFits(backend, m)) ?? null;
  const config: AgentConfig = {
    cwd: opts.cwd,
    project: opts.slug,
    ...(backend ? { backend } : {}),
    ...(model ? { model } : {}),
    permission_mode: opts.permissionMode ?? defaults.permissionMode,
    role: opts.role as AgentConfig['role'],
  };
  try {
    upsertAgent({ name, system_prompt: defaults.prompt(opts.slug, name), config });
    console.log(
      `[agent-seed] child agent ${name} created (project=${opts.slug}, role=${opts.role}, cwd=${opts.cwd}, `
      + `backend=${backend ?? 'default'}, model=${model ?? 'backend default'})`,
    );
    return true;
  } catch (err) {
    console.error(`[agent-seed] creating ${name} failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * The project's orchestrator, seeded when it has none: the agent that holds the
 * role (whatever its name), else `<slug>.main`. The project's other agents then
 * report to it by default, and it to the main agent — the tree the Agents page
 * draws. `null` when it could not be created (no `cwd`).
 */
export function ensureProjectOrchestrator(
  slug: string,
  opts: { cwd?: string | null; inherit?: InheritedLlm | null },
): string | null {
  const existing = projectOrchestratorName(slug);
  if (existing) return existing;
  const name = `${slug}.main`;
  return ensureProjectAgent(name, { slug, role: 'orchestrator', cwd: opts.cwd ?? null, inherit: opts.inherit ?? null }) ? name : null;
}

const WORKFLOW_ARCHITECT_PROMPT = `You are timon.workflow-architect. You design workflow definitions. You never apply, publish, edit, or run them yourself.

## Schema (version 1)
A complete definition is JSON of the form:
{
  "schemaVersion": 1,
  "nodes": [{ "id": "n1", "type": "<from catalogue>", "label": "…", "position": { "x": 0, "y": 0 }, "config": {} }],
  "edges": [{ "id": "e1", "from": "n1", "fromPort": "out", "to": "n2", "toPort": "in", "condition": null }],
  "variables": [{ "name": "days", "type": "number", "default": 7 }],
  "settings": { "timeoutMs": 3600000, "maxParallel": 3, "onError": "fail" }
}

Rules: unique node ids, at least one trigger.* node, edges only between existing nodes, output ports must be declared by the node type (or by agent/skill routes[]), cycles forbidden unless the edge sets loop: true with maxIterations.

## Node types
Do not invent types. Read the live catalogue from GET /api/workflows/node-types and only use those types and ports. Typical v1 types: trigger.manual, trigger.schedule (cron, tz), trigger.webhook, trigger.event (kind, filter), agent (ref or identity, input, completion turn|explicit, timeoutMs, retries, routes), skill (skillId plus agent fields), condition (expr), switch (on, cases[].port), script (bin, args, cwd, timeoutMs), parallel, join (mode all|any|n), human (question, options, timeoutMs), notify (type report|alert, title, body), memory.read, memory.write, wait (ms), output (template). There is no http node.

An agent node references an existing agent by config.ref, or declares an inline identity. Never hard-code a model or backend list: leave those unset unless the user named one, and never invent slugs.

Templates use {{input.x}}, {{vars.x}}, {{nodes.<id>.output}}. Conditions use pointed paths and == != < <= > >= contains matches exists, and or not.

## Contract
When you have a complete, validated definition, call workflow_propose(workflow_id, definition, rationale) exactly once. The tool validates the schema and stores a proposal. A human accepts or rejects it. Never PUT the workflow, never publish, never run.`;

/** Seeds the architect from the main agent's resolved configuration. The seed
 * deliberately copies no model literal: project policy remains authoritative. */
export function seedWorkflowArchitect(): void {
  const name = 'timon.workflow-architect';
  if (existsSync(agentDir(name))) return;
  const source = getAgent('timon.main') ?? getAgent('_main');
  if (!source?.cwd) return;
  const config: AgentConfig = {
    cwd: source.cwd,
    project: source.project ?? 'timon',
    backend: source.backend,
    ...(source.model ? { model: source.model } : {}),
    ...(source.permission_mode ? { permission_mode: source.permission_mode } : {}),
    role: 'orchestrator',
  };
  upsertAgent({ name, system_prompt: WORKFLOW_ARCHITECT_PROMPT, config });
}
