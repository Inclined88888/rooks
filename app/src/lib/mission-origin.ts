/**
 * Who started a mission, as the daemon derives it (`orchestrator/src/mission-origin.ts`).
 * The two packages are independent: this is the client's copy of the vocabulary.
 */
export const MISSION_ORIGINS = ['user', 'task', 'routine', 'agent', 'system'] as const;
export type MissionOrigin = (typeof MISSION_ORIGINS)[number];

/** Values of `GET /api/missions?origin=`; `automated` = every origin but `user`. */
export type MissionOriginFilter = MissionOrigin | 'automated';
export const MISSION_ORIGIN_FILTERS: readonly MissionOriginFilter[] = ['user', 'automated', 'task', 'routine', 'agent', 'system'];

export function isMissionOrigin(v: unknown): v is MissionOrigin {
  return typeof v === 'string' && (MISSION_ORIGINS as readonly string[]).includes(v);
}

/**
 * The chat rail's "started by hand" filter: hides what the daemon ran on its
 * own. It filters on origin, never on owner. The open mission stays listed whatever its origin, and a row without an
 * origin (older daemon) is never hidden.
 */
export function onlyUserMissions<M extends { id: string; origin?: string | null }>(
  missions: readonly M[],
  openMissionId: string | null,
): M[] {
  return missions.filter((m) => !isMissionOrigin(m.origin) || m.origin === 'user' || m.id === openMissionId);
}
