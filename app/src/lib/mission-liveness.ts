/**
 * What a `mission.card.badge` occupant is given about a mission.
 *
 * The daemon folds "process alive / turn in progress / turn ended / cut" into
 * one `liveness` label (`orchestrator/src/mission-liveness.ts`); this is its
 * browser-side shape. A daemon that predates the field sends none: `liveness`
 * is then `null` and no occupant has anything to say, rather than guessing from
 * `status` — the guess is the confusion this exists to remove.
 */

export type MissionLiveness = 'working' | 'turn_done' | 'open' | 'interrupted' | 'ended';

const LIVENESS: readonly string[] = ['working', 'turn_done', 'open', 'interrupted', 'ended'];

/** A mission, as a `mission.card.badge` occupant reads it. */
export type MissionItem = {
  id: string;
  agent_name: string | null;
  /** The database status: `running` only says the row is open. */
  status: string;
  /** The orchestrator holds the agent process. */
  running: boolean;
  turn_active: boolean;
  turn_complete: boolean;
  liveness: MissionLiveness | null;
  /** Why it was cut, when `liveness` is `interrupted` (`rate_limit`, `killed`, `stopped`, `crash`…). */
  interrupted_reason: string | null;
  /** Messages in the agent's inbox still to be read. */
  pending_messages: number;
  /** Requests received and not yet answered. */
  open_deliveries: number;
};

/** The fields of a missions API row this reads; everything is optional so an older daemon still parses. */
export type MissionItemSource = {
  id: string;
  agent_name?: string | null;
  status?: string;
  running?: boolean;
  turn_active?: boolean;
  turn_complete?: boolean;
  liveness?: string | null;
  interrupted_reason?: string | null;
  pending_messages?: number;
  open_deliveries?: number;
};

export function toMissionItem(m: MissionItemSource): MissionItem {
  return {
    id: m.id,
    agent_name: m.agent_name ?? null,
    status: m.status ?? '',
    running: Boolean(m.running),
    turn_active: Boolean(m.turn_active),
    turn_complete: Boolean(m.turn_complete),
    liveness: m.liveness && LIVENESS.includes(m.liveness) ? (m.liveness as MissionLiveness) : null,
    interrupted_reason: m.interrupted_reason ?? null,
    pending_messages: m.pending_messages ?? 0,
    open_deliveries: m.open_deliveries ?? 0,
  };
}
