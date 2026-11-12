/**
 * Fine state of a mission, for the clients.
 *
 * `missions.status = 'running'` only says the row is open. With a persistent
 * backend the process outlives the turn until the idle reap, so "running" was
 * read as "the agent is working" while the turn had ended minutes before — and
 * a mission killed or cut by a quota looked the same as one thinking. This
 * collapses the four facts the API already carries (process alive, turn in
 * progress, turn ended, interruption cause) into one label, so no client has
 * to re-derive it and two screens cannot disagree.
 *
 *   working      process alive, a turn is in progress
 *   turn_done    process alive, the last turn ended — waiting for the next message
 *   open         row still `running`, but nothing is going on: no process (waiting
 *                for a resume), or alive without a finished turn yet
 *   interrupted  cut by the system or by hand — `interrupted_reason` says why
 *   ended        finished with no interruption cause
 *
 * An interruption cause wins over a live process: `interrupted_reason` is
 * cleared when a later turn succeeds (agent.ts), so a cause still standing on
 * an open mission means its last turn did not complete.
 */
import { toInterruptionReason, type InterruptionReason } from './interruption.js';

export type MissionLiveness = 'working' | 'turn_done' | 'open' | 'interrupted' | 'ended';

export type MissionLivenessInput = {
  status: string;
  /** The orchestrator holds the process in memory. */
  process_alive: boolean;
  turn_active: boolean;
  turn_complete: boolean;
  interrupted_reason: string | null;
};

export function missionLiveness(m: MissionLivenessInput): { liveness: MissionLiveness; interrupted_reason: InterruptionReason | null } {
  const reason = toInterruptionReason(m.interrupted_reason);
  if (m.status !== 'running') {
    return { liveness: reason ? 'interrupted' : 'ended', interrupted_reason: reason };
  }
  if (reason && !m.turn_active) return { liveness: 'interrupted', interrupted_reason: reason };
  if (!m.process_alive) return { liveness: 'open', interrupted_reason: reason };
  if (m.turn_active) return { liveness: 'working', interrupted_reason: reason };
  return { liveness: m.turn_complete ? 'turn_done' : 'open', interrupted_reason: reason };
}
