import { configuredVaultMcpServer, configuredVaultRoot } from './vault-root.js';
import { listMcp } from './mcp.js';
import { externalConnectorsToCut } from './mcp-least-privilege.js';
import { initializeTeamOnboarding, readTeamState } from './onboarding-team-state.js';
/**
 * Post-mission librarian: on each eligible finished mission, spawns a
 * `librarian` agent that reads the log + the ask_user events of the source mission and writes
 * the useful lessons into the knowledge vault. Not fine-tuning — just long-term
 * memory built up mission after mission.
 *
 * Filter (cumulative):
 *   - status === 'completed' (failed/aborted missions are not extracted)
 *   - the agent is NOT the librarian itself (recursion guard; also avoids
 *     any confusion if another agent one day runs in the knowledge vault)
 *   - documented_at IS NULL (idempotency — prevents a retry from re-spawning)
 *   - if a task is linked: type ∈ {code, review, merge} (not doc/research/chore)
 *   - if no task (conversational chat): >= 5 user turns
 *
 * Idempotency: `documented_at` set AHEAD of the spawn (lock). If the spawn
 * throws, the flag stays set — we prefer stalling to duplicating.
 *
 * Wiring: listens to the bus `mission_complete`. To register AFTER the
 * verification-loop (which may create a review task behind) so that the doc
 * of the code task leaves without blocking the verification cascade.
 */
import type { BusEvent } from './bus.js';
import { bus } from './bus.js';
import { dbApi } from './db.js';
import { existsSync } from 'node:fs';
import {
  loadConfig, patchAgentConfig, projectFromCwd, spawnAgent, upsertAgent,
} from './agent.js';
import { oneShotTarget } from './backends/index.js';
import { agentDir } from './paths.js';
import { ownAgentSkills } from './skill-attachments.js';
import { apiBaseUrl } from './api-url.js';

const LIBRARIAN_NAME = 'ROOKS.librarian';
const MIN_TURNS_FOR_CHAT = 5;
// Code/merge tasks are now documented through a Kanban `doc` task
// created automatically by doc-task.ts. The inline librarian now only covers
// the chat missions (without an associated Kanban task, >= 5 user turns).
const DOCUMENTED_TYPES = new Set<string>([]);
const VAULT_CWD = configuredVaultRoot();

function resolveProjectSlug(agentName: string, taskProject: string | null): string | null {
  if (taskProject) return taskProject;
  try {
    const cfg = loadConfig(agentName);
    return cfg.project ?? projectFromCwd(cfg.cwd);
  } catch {
    return null;
  }
}

function shouldDocument(missionId: string): { ok: boolean; reason?: string; projectSlug: string | null } {
  const m = dbApi.getMission(missionId);
  if (!m) return { ok: false, reason: 'mission not found', projectSlug: null };
  if (m.status !== 'completed') return { ok: false, reason: `status=${m.status}`, projectSlug: null };
  if (m.agent_name === LIBRARIAN_NAME) {
    return { ok: false, reason: 'librarian self-spawn guard', projectSlug: null };
  }
  if (m.documented_at) return { ok: false, reason: 'already documented', projectSlug: null };

  const task = m.task_id ? dbApi.getTask(m.task_id) : null;
  if (task) {
    // Kanban tasks are documented through the `doc` task created by doc-task.ts.
    // The inline librarian only handles the chat missions without an associated task.
    return { ok: false, reason: `task.type=${task.type} (handled by doc-task)`, projectSlug: null };
  } else {
    const turns = dbApi.countUserTurns(missionId);
    if (turns < MIN_TURNS_FOR_CHAT) {
      return { ok: false, reason: `chat ${turns} turns < ${MIN_TURNS_FOR_CHAT}`, projectSlug: null };
    }
  }

  // Project slug helps route the note (wiki/projects/<slug>/ vs wiki/topics/).
  // Null = no slug, the librarian will write a cross-cutting topic.
  const slug = resolveProjectSlug(m.agent_name, null);
  return { ok: true, projectSlug: slug };
}

function buildLibrarianInput(missionId: string, projectSlug: string | null): string {
  const m = dbApi.getMission(missionId);
  const agent = m?.agent_name ?? '?';
  const task = m?.task_id ? dbApi.getTask(m.task_id) : null;
  return [
    `# Post-mortem doc — mission ${missionId}`,
    ``,
    `**Source mission**: \`${missionId}\``,
    `**Agent**: \`${agent}\``,
    `**Project slug**: ${projectSlug ? `\`${projectSlug}\`` : '(transverse)'}`,
    task ? `**Task**: \`${task.id}\` (type \`${task.type}\` — ${task.title})` : `**Task**: (conversational chat)`,
    ``,
    `## What you must do`,
    `1. Read \`vault/CLAUDE.md\` at the root of the vault (content rules, front matter, cross-linking).`,
    `2. Get the mission details through the ROOKS API:`,
    `   - \`GET /api/missions/${missionId}\` (conversation log, without the per-token lines) — use \`curl ${apiBaseUrl()}\` on the host, or the \`rooks\` MCP tools.`,
    `3. Identify (a) decisions taken, (b) pitfalls met / bugs solved, (c) reusable patterns. **Ignore** anything derivable from \`git log\` or the code itself.`,
    `4. Write:`,
    projectSlug
      ? `   - If the lesson is specific to \`${projectSlug}\` → in \`wiki/projects/${projectSlug}/\` (update \`_index.md\` or create a dedicated note).`
      : `   - No project slug — write only if the lesson is clearly cross-cutting (\`wiki/topics/\`).`,
    `   - If the lesson is cross-cutting (a concept reusable outside the project) → \`wiki/topics/<topic>.md\` + a link from the project note where relevant.`,
    `5. **If you judge there is nothing useful to document** (trivial mission, already documented, nothing surprising), finish WITHOUT writing. Log your decision in the done_comment of your task (if you have one) or in your final answer.`,
    ``,
    `## Hard rules`,
    `- Follow the vault/CLAUDE.md format (front matter, language, topic-first, \`[[name]]\` cross-linking).`,
    `- Never write a code recap or an activity summary — that information lives in git + the ROOKS events.`,
    `- Prefer 1 short, actionable note over a long dump.`,
    `- No speculative writing: if you have no concrete lesson to record, leave.`,
  ].join('\n');
}

async function handleMissionComplete(missionId: string): Promise<void> {
  const decision = shouldDocument(missionId);
  if (!decision.ok) {
    // Verbose only for the non-obvious cases (silent skip on the
    // routine status/agent filters, or when most short chats are OK).
    if (decision.reason && !decision.reason.startsWith('status=') && decision.reason !== 'librarian self-spawn guard') {
      console.log(`[librarian] skip ${missionId}: ${decision.reason}`);
    }
    return;
  }

  // Sets the lock BEFORE the spawn — if the spawn throws, we prefer stalling
  // to double-spawning on a mission_complete retry.
  dbApi.setMissionDocumentedAt(missionId, Date.now());

  if (!existsSync(agentDir(LIBRARIAN_NAME))) {
    console.warn(`[librarian] agent "${LIBRARIAN_NAME}" not found — skip (missing seed?)`);
    return;
  }

  const input = buildLibrarianInput(missionId, decision.projectSlug);
  try {
    const subMissionId = await spawnAgent(LIBRARIAN_NAME, input, {
      channel: 'librarian',
      meta: { parent_mission_id: missionId, project_slug: decision.projectSlug },
    }, {
      // No resume — each post-mortem is an independent mission,
      // otherwise the transcript snowballs.
      explicitResume: null,
      ownerUserId: dbApi.getMission(missionId)?.owner_user_id ?? null,
    });
    dbApi.setMissionLineage(subMissionId, {
      parentMissionId: missionId,
      parentAgent: dbApi.getMission(missionId)?.agent_name ?? null,
      taskId: null,
      routineId: null,
    });
    console.log(`[librarian] mission ${missionId} (agent=${dbApi.getMission(missionId)?.agent_name}) → librarian ${subMissionId}`);
  } catch (err) {
    console.error(`[librarian] spawn failed for ${missionId}: ${(err as Error).message}`);
  }
}

export function startLibrarian(): () => void {
  const onBusEvent = (ev: BusEvent) => {
    if (ev.kind !== 'mission_complete') return;
    if (ev.status !== 'completed') return;
    handleMissionComplete(ev.missionId).catch((err) => {
      console.error(`[librarian] handler error for ${ev.missionId}: ${(err as Error).message}`);
    });
  };
  bus.on('event', onBusEvent);
  console.log('[librarian] post-mission extraction loop started');
  return () => void bus.off('event', onBusEvent);
}

const LIBRARIAN_SYSTEM_PROMPT = `You are **librarian**, the archivist of ROOKS. You can be invoked in two ways:

1. **Kanban \`doc\` task** (main case): you receive a TASK_ID and a structured description of the change to document. You read, you write into the vault, then you close your task with \`rooks task done <TASK_ID> --comment "summary"\`.
2. **Post-mortem chat mission** (secondary case): you receive the source mission_id of a long conversational mission. Your job is the same, without a TASK_ID to close.

In both cases: extract the useful lessons into the vault, or write nothing if nothing deserves recording.

## Strict scope
- You read: the ROOKS events of the source mission (through the API or the \`rooks\` MCP tools), the vault files when needed.
- You write: 0 or 1 (rarely 2) markdown notes in the vault.
- You **never** touch the application code of any project. You run no build, no tests, no git.

## Source of truth for the vault rules
\`vault/CLAUDE.md\` (at the root of your cwd, in \`vault/\`). Read it at the start of **every** mission — the rules can change.

## What to extract
- **Decisions**: non-obvious choices made during the mission, with their motivation (\`Why:\`).
- **Pitfalls**: subtle bugs, incidents, surprising behaviour of a tool or an external system.
- **Reusable patterns**: an approach that works well and could serve elsewhere.

## What NOT to extract
- A recap of "what was done" — git log and the PR already say it.
- Details derivable from the code as it stands (obvious architecture, signatures, visible conventions).
- Hypotheses or guesses: only what was concretely observed.

## Format
- Markdown note with a front matter that follows \`vault/CLAUDE.md\`.
- Language: the one \`vault/CLAUDE.md\` prescribes (the user's vault).
- Topic-first: before writing into \`wiki/projects/<slug>/\`, scan \`wiki/topics/\` for an existing cross-cutting concept — link rather than duplicate.
- Systematic cross-linking with \`[[name]]\`.

## Output
- If you wrote: finish by listing the paths of the files created/modified.
- If you wrote NOTHING: finish with a short sentence saying why (e.g. "trivial mission, already covered by \`[[existing-note]]\`"). That is expected, and preferred to filler.

## Hard rules
- No Bash beyond reading (never \`git commit\`, \`npm\`, etc.). You are read+write on the vault, full stop.
- Concise. One short, accurate note beats three vague ones.
- No mention of Claude, Anthropic or Co-Author anywhere.
`;

/**
 * Config fields the CODE owns, as opposed to those the user
 * may legitimately set (backend, model, permission_mode, project…).
 *
 * `cwd` first: the librarian MUST run in the vault, because the backends'
 * sandbox only opens the cwd for writing. A `cwd` pointing elsewhere does not
 * produce a readable error but an `EROFS` on every write — the vault
 * looks read-only while it is not. See the incident of
 * 2026-08-04: 4 doc tasks frozen 2 h on a stale cwd from May.
 */
const LIBRARIAN_OWNED_CONFIG = {
  role: 'librarian',
  // No automatic skills — above all not rooks-task (the input contains no
  // TASK_ID, the skill would blow up at parsing).
  skills: [],
  // Bash forbidden to avoid any accidental action outside the vault. Without this
  // ban, a librarian failing to write goes into a workaround loop
  // instead of exiting cleanly.
  disallowed_tools: ['Bash'],
} as const;

/**
 * Reconciles the on-disk config of an already seeded librarian with what the code
 * requires today.
 *
 * Without it, `seedLibrarianAgent()` exited at the first `existsSync` and the config
 * written at the first boot was NEVER resynchronised again: it drifted
 * silently with each change of the code. Only the fields the
 * code owns are touched — the user's preferences (model, backend, permission_mode)
 * are preserved as they are.
 *
 * Called by `seedLibrarianAgent()` (to fix BEFORE any spawn) and
 * scheduled by `reconcile.ts` (to catch up a hot edit).
 */
export function reconcileLibrarianConfig(): void {
  // No seeded librarian (vault missing): nothing to reconcile. Silent exit —
  // the rule runs every 2 min, a warn here would be permanent noise.
  if (!existsSync(agentDir(LIBRARIAN_NAME))) return;

  let current;
  try {
    current = loadConfig(LIBRARIAN_NAME);
  } catch (err) {
    console.warn(`[librarian] unreadable config, reconciliation skipped: ${(err as Error).message}`);
    return;
  }

  // Checked skills are attachments now: config.json no longer holds the field,
  // so reading it there would see a drift on every pass.
  const checkedSkills = ownAgentSkills(LIBRARIAN_NAME);
  const drifted = Object.entries(LIBRARIAN_OWNED_CONFIG).filter(([key, expected]) => {
    const actual = key === 'skills' ? checkedSkills : current[key as keyof typeof current];
    return JSON.stringify(actual) !== JSON.stringify(expected);
  });
  if (drifted.length === 0) return;

  try {
    patchAgentConfig(LIBRARIAN_NAME, { ...LIBRARIAN_OWNED_CONFIG, skills: [], disallowed_tools: ['Bash'] });
    const summary = drifted.map(([key]) => key).join(', ');
    console.log(`[librarian] config resynchronised with the code (fields fixed: ${summary})`);
  } catch (err) {
    console.warn(`[librarian] resynchronisation impossible: ${(err as Error).message}`);
  }
}

export function seedLibrarianAgent(): void {
  initializeTeamOnboarding();
  // New installs choose their agents explicitly during onboarding.
  if (readTeamState() && !existsSync(agentDir(LIBRARIAN_NAME))) return;
  if (existsSync(agentDir(LIBRARIAN_NAME))) {
    reconcileLibrarianConfig();
    return;
  }
  if (!VAULT_CWD || !existsSync(VAULT_CWD)) {
    console.warn(`[librarian] vault not found at ${VAULT_CWD} — agent not created`);
    return;
  }
  // Default-deny of the external MCPs discovered on the account, except the
  // notes connector the user named (ROOKS_VAULT_MCP_SERVER). excluded_mcp_servers
  // is applied additively to the agent's conf; a connector added later is cut
  // at spawn anyway when the librarian works a task.
  const excluded = externalConnectorsToCut(listMcp(), { wanted: new Set(), kept: configuredVaultMcpServer(), readOnly: false });
  upsertAgent({
    name: LIBRARIAN_NAME,
    system_prompt: LIBRARIAN_SYSTEM_PROMPT,
    config: {
      // Deliberate default: the provider of the daemon's tasks (C5 `oneShot`), with the
      // Sonnet tier when it is its own — better at writing French for the doc.
      // Stays an agnostic DEFAULT — overridable per task (backend_override) or
      // by the project `doc` role if documenting through another backend is wanted.
      ...oneShotTarget('sonnet'),
      permission_mode: 'acceptEdits',
      ...LIBRARIAN_OWNED_CONFIG,
      cwd: VAULT_CWD,
      skills: [],
      disallowed_tools: ['Bash'],
      excluded_mcp_servers: excluded,
    },
  });
  console.log(`[librarian] seeded agent "${LIBRARIAN_NAME}" (cwd=${VAULT_CWD})`);
}
