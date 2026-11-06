/**
 * How loudly the setup conversation offers a way out: pure, so the decision is
 * tested without the page.
 *
 * The step must never trap anyone. A tester's agent had every Timon tool
 * refused (401): no card, no `setup_finish`, the step stayed open, and the
 * first-run gate kept sending every page back to `/setup/agent`. "Skip" only
 * lived on the "assistant unavailable" screen, which a chat that started and
 * then failed never reaches. So the way out is always on screen — quiet while
 * the conversation goes well, prominent as soon as something says it will not.
 */

/** What the chat itself reported (`ChatClient` `onSetupTrouble`). */
export type SetupChatSignal = 'tool_error' | 'interrupted' | 'spawn_failed' | 'ended';

export type SetupMissionState = {
  /** `missions.status`: anything but `running` is a conversation that will not answer. */
  status: string | null;
  /** `missionLiveness` of the daemon, when it sent one. */
  liveness?: string | null;
};

export type SetupTroubleInput = {
  signal: SetupChatSignal | null;
  /** The last status read, `null` until the first poll answered. */
  mission: SetupMissionState | null;
  /** Consecutive polls that got no answer: the daemon or the stream is gone. */
  pollFailures: number;
  /** The agent's first words (or its first card) are on screen. */
  spoke: boolean;
  /** Time since the conversation was put on screen. */
  elapsedMs: number;
};

export type SetupTroubleReason = 'tool_error' | 'interrupted' | 'ended' | 'silent' | 'disconnected';

export type SetupTrouble =
  | { level: 'quiet' }
  | { level: 'prominent'; reason: SetupTroubleReason; canRestart: boolean };

/**
 * The daemon already waits up to 60 s for the first turn before it answers the
 * start request (`FIRST_TURN_MS`); this is on top of that, once the chat shows.
 */
export const SILENT_AFTER_MS = 30_000;
/** Two polls in a row without an answer (5 s): one lost request is not an outage. */
export const DISCONNECTED_AFTER = 2;

function missionDead(mission: SetupMissionState | null): boolean {
  if (!mission) return false;
  if (mission.status !== null && mission.status !== 'running') return true;
  return mission.liveness === 'ended' || mission.liveness === 'interrupted';
}

export function setupTrouble(input: SetupTroubleInput): SetupTrouble {
  // A dead mission comes first: it is the only case where starting over helps.
  if (missionDead(input.mission) || input.signal === 'ended' || input.signal === 'spawn_failed') {
    return { level: 'prominent', reason: input.signal === 'spawn_failed' ? 'interrupted' : 'ended', canRestart: true };
  }
  if (input.signal === 'tool_error') return { level: 'prominent', reason: 'tool_error', canRestart: false };
  if (input.signal === 'interrupted') return { level: 'prominent', reason: 'interrupted', canRestart: false };
  if (input.pollFailures >= DISCONNECTED_AFTER) return { level: 'prominent', reason: 'disconnected', canRestart: false };
  if (!input.spoke && input.elapsedMs >= SILENT_AFTER_MS) return { level: 'prominent', reason: 'silent', canRestart: false };
  return { level: 'quiet' };
}

/** A tool answer that says the agent cannot act: an error, or an HTTP refusal it got as text. */
const REFUSAL = /\b(401|403)\b|unauthori[sz]ed|forbidden/i;

type ToolLike = { result?: { text: string; isError: boolean } };
type MessageLike = { role: string; tools?: ToolLike[] };

/**
 * Reads the conversation for a failure the agent will not get past alone.
 *
 * Every tool error counts, not only the Timon tools': the setup skill only calls
 * those, so anything failing here is the conversation failing. A notice is
 * what the chat writes for an interrupted turn, a CLI that never started or a
 * replay given up on.
 */
export function chatTroubleSignal(messages: readonly MessageLike[]): SetupChatSignal | null {
  let signal: SetupChatSignal | null = null;
  for (const m of messages) {
    if (m.role === 'notice') signal = signal ?? 'interrupted';
    for (const tool of m.tools ?? []) {
      if (tool.result && (tool.result.isError || REFUSAL.test(tool.result.text))) return 'tool_error';
    }
  }
  return signal;
}
