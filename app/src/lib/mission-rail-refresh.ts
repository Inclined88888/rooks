/**
 * When the chat's mission rail re-reads `GET /api/missions`.
 *
 * It used to poll every 10 s, from every mounted chat: N chats, N lists, and
 * each list held the daemon's single thread (better-sqlite3 is synchronous).
 * The rail now follows the global SSE stream and keeps a slow poll only for
 * what the stream cannot say (a dropped connection, a field nothing announces).
 */

/** Global-stream frames that can change what the rail shows. */
export const RAIL_FRAMES = ['mission_started', 'mission_complete', 'turn_complete', 'event'] as const;
export type RailFrame = (typeof RAIL_FRAMES)[number];

/** Frames landing together (a turn's end and its mission's end) cost one read. */
export const RAIL_REFRESH_DEBOUNCE_MS = 500;
/** Safety net behind the stream. */
export const RAIL_FALLBACK_POLL_MS = 60_000;

export type RailRow = { id: string; turn_active?: boolean };

function missionIdOf(data: string): { missionId: string; type?: unknown } | null {
  try {
    const parsed = JSON.parse(data) as { missionId?: unknown; type?: unknown } | null;
    return parsed && typeof parsed.missionId === 'string' ? { missionId: parsed.missionId, type: parsed.type } : null;
  } catch {
    return null;
  }
}

/**
 * True when `data` (a frame of kind `kind`) changes the rail:
 * - a mission started: it may belong to the rail (its agent's project is not
 *   known here, and starts are rare);
 * - a turn or a mission of the rail ended;
 * - a `user` event on a rail mission not shown as working: a turn began. Once
 *   the rail shows it working, the next ones (tool results are `user` events
 *   too) are ignored — the stream carries every event of every mission, and
 *   reading the list on each would be worse than the poll it replaces.
 */
export function railFrameMatters(kind: string, data: string, rail: readonly RailRow[]): boolean {
  if (kind === 'mission_started') return true;
  if (kind !== 'mission_complete' && kind !== 'turn_complete' && kind !== 'event') return false;
  // Cheap filter before parsing: the stream sends one frame per thinking token.
  if (kind === 'event' && !data.includes('"user"')) return false;
  const frame = missionIdOf(data);
  if (!frame) return false;
  const row = rail.find((m) => m.id === frame.missionId);
  if (!row) return false;
  if (kind === 'event') return frame.type === 'user' && row.turn_active !== true;
  return true;
}
