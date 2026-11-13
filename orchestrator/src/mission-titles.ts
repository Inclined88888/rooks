/**
 * Automatic mission titles (TODO #358): a short, readable name for every
 * conversation the user opens by hand, shown by the missions list instead of
 * the truncated first message.
 *
 * Rank of the sources — see `mission-title-source.ts` —: manual > preset >
 * native > generated. This module owns the lowest one: a one-shot asked at the
 * end of the FIRST turn (`turn_complete`), on `oneShotPrompt` (`summary.ts`),
 * never a parallel mission. It is asynchronous, off the turn's path, bounded by
 * a short timeout and silent on failure (a log line, never a user error).
 *
 * What never generates: a mission the machine started — a Kanban task, a
 * routine or trigger, an agent delegating or waking up, a workflow node, the
 * daemon's own housekeeping. The exclusion is by ORIGIN (`getMissionOrigin`,
 * the list's own SQL: lineage columns and spawn channel), never by matching the
 * text of the brief, which the next prefix would break.
 *
 * First turn only: a mission whose events already hold more than one user
 * message is past it — an old conversation resumed, a mission that predates
 * the feature — and is skipped before anything is claimed. The migration also
 * marks every mission that predates the column as claimed: no backfill, by
 * decision (quota), and no one-shot on the next message to a 6 000-row history.
 *
 * Idempotence: `claimMissionTitleGeneration` is a conditional UPDATE taken
 * before the one-shot — a replayed turn, a second `turn_complete`, two daemons
 * racing on the same row: one generation at most. And the write of the result
 * goes through `setMissionTitleIfUnclaimed`, whose WHERE re-checks the rank:
 * a rename that lands while the one-shot runs wins the race whatever the order.
 */
import { dbApi, type MissionRow } from './db.js';
import { loadConfig, type AgentConfig } from './agent-config.js';
import { bus, type BusEvent } from './bus.js';
import { settingNum } from './settings.js';
import { resolveMissionTitleLlm } from './mission-title-model.js';

/** Upper bound of a generated title, in characters: a list row, not a summary. */
export const MISSION_TITLE_MAX_CHARS = 80;
/** How much of the first message the title model reads. Enough for the ask, never a whole brief. */
const PROMPT_EXCERPT_CHARS = 2_000;

export const TITLE_SYSTEM_PROMPT = `You name conversations for a list of past conversations.
Read the user's first message and answer with a title of 4 to 6 words that says what they asked for.
Write the title in the language of the message. Output the title alone: no quotes, no trailing period,
no explanation, no markdown, one line.`;

/** What the one-shot needs to know of the mission to run on its own LLM. */
export type TitleOneShot = (agentName: string, cfg: AgentConfig, userMessage: string, systemPrompt: string, timeoutMs: number) => Promise<string>;

export type MissionTitleDeps = {
  /** The one-shot runner; injected by the tests, `oneShotPrompt` otherwise. */
  oneShot?: TitleOneShot;
  /** Decides backend and model for a mission; `resolveMissionTitleLlm` (account choice > instance setting > auto) by default. */
  resolveLlm?: (mission: MissionRow) => { backend: string; model: string | null } | 'off';
};

/**
 * Makes one line of a model's answer: first non-empty line, surrounding quotes
 * and a trailing period dropped, whitespace collapsed, cut at the bound. Empty
 * when the model answered nothing usable (a refusal paragraph is still kept:
 * a long title is better than none, the cut bounds it).
 */
export function sanitizeTitle(raw: string): string {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let t = line.replace(/^\s*(?:title\s*:\s*)?/i, '').replace(/\s+/g, ' ').trim();
  // french-ok: French guillemets are among the quotes a model wraps a title in
  t = t.replace(/^["'“”‘’«»`]+/, '').replace(/["'“”‘’«»`]+$/, '').trim();
  t = t.replace(/[.。]+$/, '').trim();
  if (t.length > MISSION_TITLE_MAX_CHARS) t = `${t.slice(0, MISSION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
  return t;
}

/** The mission the user opened by hand — the only kind that gets a generated title. */
export function missionTitleEligible(mission: MissionRow): boolean {
  if (mission.task_id || mission.routine_id || mission.workflow_run_id || mission.parent_mission_id) return false;
  return dbApi.getMissionOrigin(mission.id) === 'user';
}

/** The excerpt of the first message the model reads. */
export function titlePromptExcerpt(firstMessage: string): string {
  const flat = firstMessage.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_EXCERPT_CHARS ? `${flat.slice(0, PROMPT_EXCERPT_CHARS)}…` : flat;
}

async function defaultOneShot(agentName: string, cfg: AgentConfig, userMessage: string, systemPrompt: string, timeoutMs: number): Promise<string> {
  const { oneShotPrompt } = await import('./summary.js');
  return oneShotPrompt(agentName, cfg, userMessage, systemPrompt, undefined, timeoutMs);
}

/** Whether the turn that just ended was the mission's first: the kickoff is its only user message so far. */
export function missionOnFirstTurn(missionId: string): boolean {
  return dbApi.countUserTurns(missionId) <= 1;
}

/**
 * Generates and stores the title of ONE mission, once. Returns what happened:
 * `skipped` (already claimed, already titled, past its first turn, automated,
 * or generation off), `written`, `kept` (the one-shot ran but a higher-ranked
 * title had landed meanwhile, or the answer was empty) or `failed` (the
 * one-shot threw; logged).
 */
export async function generateMissionTitle(
  missionId: string,
  deps: MissionTitleDeps = {},
): Promise<'skipped' | 'written' | 'kept' | 'failed'> {
  const mission = dbApi.getMission(missionId);
  if (!mission || mission.title || mission.title_generation) return 'skipped';
  // Past the first turn: nothing is claimed either — the count only grows, so
  // the mission stays out, and a later rule (#383 / #384) may still name it.
  if (!missionOnFirstTurn(missionId)) return 'skipped';
  if (!missionTitleEligible(mission)) return 'skipped';
  const llm = (deps.resolveLlm ?? resolveMissionTitleLlm)(mission);
  if (llm === 'off') return 'skipped';
  // The claim comes AFTER the cheap checks (an automated mission never claims,
  // so a later rule may still title it) and BEFORE the one-shot.
  if (!dbApi.claimMissionTitleGeneration(missionId)) return 'skipped';
  const excerpt = titlePromptExcerpt(mission.mission);
  if (!excerpt) return 'kept';
  let cfg: AgentConfig;
  try { cfg = loadConfig(mission.agent_name); } catch { cfg = {}; }
  cfg = { ...cfg, backend: llm.backend as AgentConfig['backend'], model: llm.model ?? undefined, reasoningEffort: undefined };
  const timeoutMs = settingNum('ROOKS_MISSION_TITLE_TIMEOUT_MS');
  try {
    const raw = await (deps.oneShot ?? defaultOneShot)(mission.agent_name, cfg, excerpt, TITLE_SYSTEM_PROMPT, timeoutMs);
    const title = sanitizeTitle(raw);
    if (!title) return 'kept';
    return dbApi.setMissionTitleIfUnclaimed(missionId, title, 'generated') ? 'written' : 'kept';
  } catch (err) {
    console.warn(`[mission-titles] ${missionId}: title generation failed: ${(err as Error).message}`);
    return 'failed';
  }
}

/**
 * Listens for the end of a turn and titles the mission if it is its first one.
 * Fire-and-forget: the turn's own handlers never wait for the model. Returns
 * the disposer; the pending generations are tracked so a test can await them.
 */
export function startMissionTitles(deps: MissionTitleDeps = {}): { stop: () => void; idle: () => Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  const onBus = (ev: BusEvent): void => {
    if (ev.kind !== 'turn_complete' || ev.outcome === 'failed' || ev.outcome === 'cancelled') return;
    const run = generateMissionTitle(ev.missionId, deps)
      .catch((err) => { console.warn(`[mission-titles] ${ev.missionId}: ${(err as Error).message}`); })
      .finally(() => { pending.delete(run); });
    pending.add(run);
  };
  bus.on('event', onBus);
  return {
    stop: () => { bus.off('event', onBus); },
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}
