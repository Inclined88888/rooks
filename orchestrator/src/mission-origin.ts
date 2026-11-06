/**
 * Who started a mission (TODO #284): the human, or the machine on its behalf.
 *
 * The missions list mixes the user's own conversations with everything the
 * daemon runs for them — Kanban tasks, routines and triggers, agents waking or
 * delegating to each other, recoveries. On a busy home the user's chats are
 * fewer than one row in ten, so the list must be filterable on this, and the
 * filter must run in SQL, before the LIMIT: a client-side filter over the last
 * 200 rows would leave a handful of conversations to show.
 *
 * The machine channels are listed and everything else is the user: a plugin
 * channel (Telegram, Discord) is the human typing from another device, the same
 * reading as `isAutonomousMission` and `originFromSpawnSource`.
 */

export const MISSION_ORIGINS = ['user', 'task', 'routine', 'agent', 'system'] as const;
export type MissionOrigin = (typeof MISSION_ORIGINS)[number];

/** Accepted by `GET /api/missions?origin=` — `automated` is every origin but `user`. */
export const MISSION_ORIGIN_FILTERS = [...MISSION_ORIGINS, 'automated'] as const;
export type MissionOriginFilter = (typeof MISSION_ORIGIN_FILTERS)[number];

export function isMissionOriginFilter(v: unknown): v is MissionOriginFilter {
  return typeof v === 'string' && (MISSION_ORIGIN_FILTERS as readonly string[]).includes(v);
}

/** Daemon housekeeping: nobody asked for these missions, not even an agent. */
const SYSTEM_CHANNELS = [
  'recovery', 'verification', 'verification-loop', 'pipeline', 'librarian', 'doc', 'system', 'workflow',
] as const;

/**
 * The rule, as a SQL expression over the mission alias `m` and the alias `t`
 * of its task (LEFT JOINed on `t.id = m.task_id`). Only one form exists so the
 * list, its filter and the detail route cannot disagree. Channel names are
 * constants of this module, never input, so they are inlined.
 */
export function missionOriginSql(m: string, t: string): string {
  const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
  // CASE, not AND: SQLite does not promise to skip json_extract on bad JSON.
  const parentAgent = `COALESCE(CASE WHEN json_valid(${m}.source_meta) THEN json_extract(${m}.source_meta, '$.parent_agent') END, '') <> ''`;
  return `CASE
      -- Routines are schedule triggers since TODO #216: one bucket for both.
      WHEN ${m}.routine_id IS NOT NULL OR ${m}.source_channel = 'routine'
        OR ${t}.routine_id IS NOT NULL OR ${t}.trigger_id IS NOT NULL THEN 'routine'
      -- Old dispatcher rows only have the task id in source_meta.
      WHEN ${m}.task_id IS NOT NULL OR ${m}.source_channel = 'dispatcher' THEN 'task'
      -- A person wrote in it, or it resumed their session: the chat binds to
      -- an agent's latest mission, so a wake becomes where they keep talking.
      WHEN ${m}.user_engaged = 1 THEN 'user'
      -- wake: an agent's message or return woke this one, never the human.
      -- source_meta.parent_agent: the only lineage of agent rows older than the column.
      WHEN ${m}.source_channel = 'wake' OR ${m}.parent_mission_id IS NOT NULL
        OR (${m}.source_channel = 'agent' AND ${parentAgent}) THEN 'agent'
      WHEN ${m}.source_channel IN (${list(SYSTEM_CHANNELS)}) THEN 'system'
      ELSE 'user'
    END`;
}
