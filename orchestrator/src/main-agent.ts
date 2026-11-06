/**
 * Who the cross-project orchestrator is, once the user is allowed to name it.
 *
 * `_main` used to be that name, hard-coded in three places (`dispatcher`,
 * `notify`, `wake`) as the last-resort target of recaps, notifications and
 * wake digests. Onboarding now lets someone call their orchestrator whatever
 * they want — a fresh install lands on `_main` and nobody wants to talk to
 * `_main`. The rename moves the directory, so every literal `_main` left in a
 * fallback would silently address an agent that no longer exists: the
 * notification is written to a name nothing reads.
 *
 * So the name is RECORDED when it changes, and read from here. The literals
 * stay as the two fallbacks they always were, for installs that never renamed
 * anything.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { canonicalAgentName, listAgents, renameAgent, type RenameResult } from './agent.js';
import { AGENTS_DIR, agentDir } from './paths.js';

/** Settings key holding the current name of the cross-project orchestrator. */
export const MAIN_AGENT_KEY = 'orchestrator.main.agent';

/** The seed name, and the legacy one before it. Order matters: `_main` is what
 *  `seedDefaultAgent` writes, `TIMON.main` is what old installs carry. */
const FALLBACKS = ['_main', 'TIMON.main'] as const;

/** Seed prefix of the workspace hubs (`_main.<ws>`), see `workspaces.ts`. */
const WORKSPACE_HUB_PREFIX = '_main.';

function isWorkspaceHub(name: string): boolean {
  return name.toLowerCase().startsWith(WORKSPACE_HUB_PREFIX);
}

/**
 * The directory spelling of `name`, or `null` when no agent answers to it.
 * The callers flag the main agent by an exact comparison with the listing
 * (`main: a.name === main` in GET /api/agents): returning the candidate as
 * written meant that on a case-insensitive disk (macOS, Windows) a recorded
 * `nova` found `Nova` through `existsSync` and then flagged nobody, and the app
 * showed "Unable to find the main agent" (TIM-0079). `canonicalAgentName` does
 * not help there: its own `existsSync` short-circuit answers yes as written.
 * Only the recorded name is matched in any case: the literal `TIMON.main`
 * would otherwise answer for `timon.main`, the orchestrator of a project
 * called `timon`, and hand it every cross-project recap.
 */
function agentOnDisk(name: string, anyCase: boolean): string | null {
  let entries: string[];
  try { entries = readdirSync(AGENTS_DIR); } catch { return null; }
  const lower = name.toLowerCase();
  const match = entries.find((e) => e === name)
    ?? (anyCase ? entries.find((e) => e.toLowerCase() === lower) : undefined);
  if (!match) return null;
  try { return statSync(join(AGENTS_DIR, match)).isDirectory() ? match : null; } catch { return null; }
}

/** Record the orchestrator's new name. Called by whatever renames it. */
export function setMainAgentName(name: string): void {
  dbApi.setSetting(MAIN_AGENT_KEY, name);
}

/**
 * Why `name` cannot be removed, or `null`. The main orchestrator is the seat
 * that receives every recap: removing it leaves them addressed to a name
 * nothing reads. Another one has to be designated first.
 */
export function mainSeatRemovalRefusal(name: string): string | null {
  const seated = mainAgentName();
  if (seated && canonicalAgentName(seated) === canonicalAgentName(name)) {
    return `${seated} is the main orchestrator: designate another one before removing it`;
  }
  return null;
}

/**
 * `renameAgent`, and the recorded seat follows when the agent renamed is the
 * main orchestrator. Read before the move: the lookup checks the directory on
 * disk, and the rename only re-records a name that was recorded, so an
 * orchestrator found by a fallback (legacy name, role) would otherwise be lost.
 */
export function renameAgentKeepingSeat(oldName: string, newName: string): RenameResult {
  const wasMain = mainAgentName()?.toLowerCase() === oldName.toLowerCase();
  const result = renameAgent(oldName, newName);
  if (result.ok && wasMain) setMainAgentName(newName);
  return result;
}

/** How the seat holder was found: the recorded name, a seed literal, or the role. */
export type MainSeatSource = 'recorded' | 'literal' | 'role';

export type MainSeatHolder = { name: string; source: MainSeatSource };

/**
 * Who holds the cross-project seat right now, and how they were found, or
 * `null` when nobody does. A recorded name that was later deleted is ignored
 * rather than returned: the callers use the result to address a message.
 */
export function mainSeatHolder(): MainSeatHolder | null {
  const recorded = dbApi.getAllSettings()[MAIN_AGENT_KEY];
  const onRecord = recorded ? agentOnDisk(recorded, true) : null;
  if (onRecord) return { name: onRecord, source: 'recorded' };
  const literal = FALLBACKS.map((name) => agentOnDisk(name, false)).find((name) => name !== null);
  if (literal) return { name: literal, source: 'literal' };
  // Last resort, by ROLE and not by name: an install whose orchestrator was
  // created by hand — never seeded, never renamed through onboarding — has
  // nothing recorded and carries neither literal. It still has exactly one
  // project-less orchestrator, and that is who the recaps are for. The
  // workspace hubs `_main.<ws>` carry the role too (`agent-role-backfill`) but
  // lead a pole, not the install: counting them made two candidates out of
  // one, and the lookup answered nobody (TIM-0079). A pole lead named anything
  // else (`workspaces.lead_agent`) is the same case and is set aside the same
  // way — unless it is the only orchestrator left, then it is the install's.
  // The app applies the same rule (`app/src/lib/main-agent.ts`).
  const global = listAgents().filter((a) => a.role === 'orchestrator' && !a.project && !isWorkspaceHub(a.name));
  const leads = poleLeads();
  const outsidePoles = global.filter((a) => !leads.has(a.name.toLowerCase()));
  const pool = outsidePoles.length > 0 ? outsidePoles : global;
  return pool.length === 1 ? { name: pool[0]!.name, source: 'role' } : null;
}

/**
 * The orchestrator that exists on disk right now, or `null` if this install
 * has none.
 */
export function mainAgentName(): string | null {
  return mainSeatHolder()?.name ?? null;
}

/**
 * Who may take an empty seat: a project-less, non-ephemeral orchestrator that
 * is not a `_main.<ws>` hub — the rule `chooseMainAgent` enforces, and the one
 * the app offers (`mainSeatCandidates` in `app/src/lib/main-agent.ts`).
 */
export function mainSeatCandidates(): string[] {
  return listAgents()
    .filter((a) => a.role === 'orchestrator' && !a.project && !a.ephemeral && !isWorkspaceHub(a.name))
    .map((a) => a.name);
}

/** The seat as the API and `timon doctor` report it (TIM-0142). */
export type MainSeatState = {
  /** The agent holding the seat, `null` when it is empty. */
  holder: string | null;
  empty: boolean;
  /** Who may take it, by the rule of `mainSeatCandidates`. */
  candidates: string[];
};

export function mainSeatState(): MainSeatState {
  const holder = mainAgentName();
  return { holder, empty: holder === null, candidates: mainSeatCandidates() };
}

/** Lower-cased names of the agents leading a pole. Read straight from the
 *  table, without `syncWorkspaceTags()`: this runs on every recap and must not
 *  write; a legacy hub not yet adopted is caught by its `_main.` prefix. */
function poleLeads(): Set<string> {
  return new Set(dbApi.listWorkspaceRows().flatMap((w) => (w.lead_agent ? [w.lead_agent.toLowerCase()] : [])));
}

/**
 * The orchestrator of a PROJECT: the agent that holds the orchestrator role on
 * it, else the legacy `<slug>.main`. The role is read from the data
 * (`config.role`), never from the name — a project's orchestrator may be called
 * anything (`toto.Orchestrator`). `<slug>.main` survives only for installs whose
 * orchestrator was created before roles were stamped. `null` when the project
 * has neither: the callers decide whether the cross-project one stands in.
 */
export function projectOrchestratorName(slug: string): string | null {
  const ofProject = listAgents().filter((a) => a.project?.toLowerCase() === slug.toLowerCase());
  // The `orchestrator: true` flag counts too, as everywhere else an agent is
  // asked whether it orchestrates (`listAgents().orchestrator`): an agent an
  // orchestrator created for a project may carry the flag and no role at all
  // (TIM-0067, `domotique.Orchestrator`). The role holder wins over a flag
  // holder; an ephemeral agent is never a project's standing orchestrator.
  const orch = ofProject.find((a) => a.role === 'orchestrator')
    ?? ofProject.find((a) => a.orchestrator && !a.ephemeral);
  if (orch) return orch.name;
  // Case-insensitive, as the handoff always was: `toto.main` on disk answers
  // for a project registered as `Toto`.
  const perProject = canonicalAgentName(`${slug}.main`);
  return existsSync(agentDir(perProject)) ? perProject : null;
}

/** Who answers for a project: its own orchestrator, else the cross-project
 *  one. Shared by the dispatcher (recap routing) and the TO DO handoff, so the
 *  two never disagree on who a project's orchestrator is. */
export function orchestratorForProject(slug: string | null | undefined): string | null {
  return (slug ? projectOrchestratorName(slug) : null) ?? mainAgentName();
}

/** Same lookup for callers that must address SOMETHING — the seed name is the
 *  historical behaviour when no orchestrator can be found at all. */
export function mainAgentNameOrSeed(): string {
  return mainAgentName() ?? FALLBACKS[0];
}

export type SetMainResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Designate an EXISTING orchestrator as the main one, without renaming
 * anything. Onboarding only records the name through a rename of `_main`,
 * which cannot work once the orchestrator the user actually talks to was
 * created by hand next to it: nothing is recorded, the lookup above lands on
 * `_main`, and every wake recap is addressed to an agent nobody reads.
 *
 * Only a project-less, non-ephemeral orchestrator can hold the seat: a
 * project's own `<slug>.main` or a coder would swallow recaps of other
 * projects.
 */
export function chooseMainAgent(name: string): SetMainResult {
  const target = listAgents().find((a) => a.name === name)
    ?? listAgents().find((a) => canonicalAgentName(a.name) === canonicalAgentName(name));
  if (!target) return { ok: false, error: `agent not found: ${name}` };
  if (target.ephemeral) return { ok: false, error: `${target.name} is ephemeral and cannot be the main orchestrator` };
  if (target.role !== 'orchestrator') {
    return { ok: false, error: `${target.name} is not an orchestrator (role: ${target.role ?? 'none'})` };
  }
  if (target.project) {
    return { ok: false, error: `${target.name} belongs to project ${target.project}; the main orchestrator is cross-project` };
  }
  setMainAgentName(target.name);
  return { ok: true, name: target.name };
}
