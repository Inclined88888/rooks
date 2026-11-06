export type MissionActivity = 'thinking' | 'needs_action' | 'idle';

export type MissionActivityInput = {
  running?: boolean;
  turn_active?: boolean;
  pending_action_at?: number | null;
};

/** Per-mission activity read off the missions list itself. `/api/agents/active`
 *  keeps a single entry per agent, so two missions of the same agent cannot
 *  both be told apart from it. */
export function missionActivity(m: MissionActivityInput): MissionActivity {
  if (m.pending_action_at) return 'needs_action';
  if (m.turn_active) return 'thinking';
  return 'idle';
}
