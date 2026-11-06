/**
 * What the missions lists show as a mission's name (TODO #358), and how they
 * follow a title written by the daemon while they are on screen.
 *
 * One rule for every list (chat rail, Missions table, picker, cockpit card):
 * the stored title — set by hand, by the launcher, read from the CLI or
 * generated — else the Kanban task title, else the first line of the brief
 * with the `TASK_ID: <uuid>` preamble peeled off. The daemon says which source
 * set the title (`title_source`); the lists only paint it.
 */

export const MISSION_TITLE_SOURCES = ['manual', 'preset', 'native', 'generated'] as const;
export type MissionTitleSource = (typeof MISSION_TITLE_SOURCES)[number];

export type MissionTitleFields = {
  id: string;
  title?: string | null;
  task_title?: string | null;
  mission?: string | null;
};

/** The body of a `mission_title_changed` event of the global stream. */
export type MissionTitleChange = {
  missionId: string;
  title: string | null;
  source: MissionTitleSource | null;
};

function firstLine(text: string): string {
  return text.replace(/^TASK_ID:\s*[0-9a-f-]{8,}\s*\n+/i, '').trim().split('\n')[0]?.trim() ?? '';
}

/** The name a list shows; `fallback` when the mission has nothing to say. */
export function missionDisplayTitle(m: MissionTitleFields, fallback = ''): string {
  const own = (m.title ?? '').replace(/\s+/g, ' ').trim();
  if (own) return own;
  const task = (m.task_title ?? '').replace(/\s+/g, ' ').trim();
  if (task) return task;
  return firstLine(m.mission ?? '').replace(/\s+/g, ' ').trim() || fallback;
}

/** The event's body as the stream carries it, or null for anything else. */
export function parseMissionTitleChange(raw: string): MissionTitleChange | null {
  try {
    const data = JSON.parse(raw) as { missionId?: unknown; title?: unknown; source?: unknown };
    if (typeof data.missionId !== 'string' || !data.missionId) return null;
    const title = typeof data.title === 'string' ? data.title : null;
    const source = (MISSION_TITLE_SOURCES as readonly string[]).includes(String(data.source)) ? data.source as MissionTitleSource : null;
    return { missionId: data.missionId, title, source };
  } catch {
    return null;
  }
}

/**
 * The list with the event applied: the same array when no row carries that
 * mission (no re-render), a new one otherwise. A mission the list does not
 * hold is not added: the next poll decides whether it belongs.
 */
export function applyMissionTitleChange<T extends { id: string; title?: string | null; title_source?: string | null }>(
  list: readonly T[],
  change: MissionTitleChange,
): readonly T[] {
  let touched = false;
  const next = list.map((m) => {
    if (m.id !== change.missionId) return m;
    if ((m.title ?? null) === change.title && (m.title_source ?? null) === change.source) return m;
    touched = true;
    return { ...m, title: change.title, title_source: change.source };
  });
  return touched ? next : list;
}
