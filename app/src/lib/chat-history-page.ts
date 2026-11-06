/**
 * A chat opens on the last page of its mission's journal, and walks back a
 * page at a time (`GET /api/missions/:id?tail=&before=`,
 * docs/MISSION-HISTORY-PAGES.md). The pieces of that walk that hold no React
 * state: the page size, the prelude that stands in for the rows not loaded,
 * where an older page goes in the thread, and which live rows are already
 * covered by a page still to load.
 */

/** Journal rows of a page (chat view). The thread mounts 60 messages; a step
 *  of an agent turn takes several rows (text, tool call, tool result). */
export const CHAT_HISTORY_PAGE = 300;
/** Pages one "show older" may read to reach a screenful of older messages. */
export const OLDER_PAGES_MAX = 4;

/** `id` is informative only: the cursor comes from `oldest_event_id`. */
export type HistoryEvent = { id: number | null; type: string; timestamp: number; payload: unknown };

export type TodoToolUse = { id: string; name: string; input: Record<string, unknown> };

/** What the rows before the tail page left behind (server: `readHistoryPrelude`). */
export interface ChatHistoryPrelude {
  sessionId: string | null;
  backend: string | null;
  model: string | null;
  observedModel: string | null;
  stats: { tok: number; cost: number };
  totals: { in: number; out: number };
  contextWindows: Record<string, number>;
  lastContextTokens: number;
  lastHumanText: string | null;
  todoToolUses: TodoToolUse[];
  /** Replayed before the page: last rate limits, cards still waiting. */
  events: HistoryEvent[];
}

/** Where the loaded history stops. */
export interface HistoryCursor {
  oldestId: number | null;
  /** Timestamp of the oldest row loaded. */
  oldestAt: number | null;
  hasMore: boolean;
}

export const NO_HISTORY: HistoryCursor = { oldestId: null, oldestAt: null, hasMore: false };

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function parseHistoryEvents(raw: unknown): HistoryEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const ev = record(item);
    if (!ev || typeof ev.type !== 'string' || typeof ev.timestamp !== 'number') return [];
    return [{ id: typeof ev.id === 'number' ? ev.id : null, type: ev.type, timestamp: ev.timestamp, payload: ev.payload }];
  });
}

export function parseHistoryPrelude(raw: unknown): ChatHistoryPrelude | null {
  const p = record(raw);
  if (!p) return null;
  const stats = record(p.stats);
  const totals = record(p.totals);
  const windows: Record<string, number> = {};
  for (const [key, value] of Object.entries(record(p.context_windows) ?? {})) {
    if (typeof value === 'number' && value > 0) windows[key] = value;
  }
  const todoToolUses = (Array.isArray(p.todo_tool_uses) ? p.todo_tool_uses : []).flatMap((item): TodoToolUse[] => {
    const use = record(item);
    const name = str(use?.name);
    return use && name ? [{ id: typeof use.id === 'string' ? use.id : '', name, input: record(use.input) ?? {} }] : [];
  });
  return {
    sessionId: str(p.session_id),
    backend: str(p.backend),
    model: str(p.model),
    observedModel: str(p.observed_model),
    stats: { tok: num(stats?.tok), cost: num(stats?.cost) },
    totals: { in: num(totals?.in), out: num(totals?.out) },
    contextWindows: windows,
    lastContextTokens: num(p.last_context_tokens),
    lastHumanText: str(p.last_human_text),
    todoToolUses,
    events: parseHistoryEvents(p.events),
  };
}

/** The cursor a page response leaves: `has_more`, `oldest_event_id`, and the
 *  timestamp of its oldest row (or the previous one when the page is empty). */
export function cursorAfterPage(raw: unknown, events: readonly HistoryEvent[], previous: HistoryCursor = NO_HISTORY): HistoryCursor {
  const body = record(raw);
  return {
    oldestId: typeof body?.oldest_event_id === 'number' ? body.oldest_event_id : previous.oldestId,
    oldestAt: events[0]?.timestamp ?? previous.oldestAt,
    hasMore: body?.has_more === true,
  };
}

/**
 * A live row older than the history loaded: the stream replays up to 500 raw
 * rows when it opens, more than a page may hold. Ingested, such a row would
 * land at the bottom of the thread; its page brings it in its place later.
 */
export function belowHistoryFloor(timestamp: number, cursor: HistoryCursor): boolean {
  return cursor.hasMore && cursor.oldestAt !== null && timestamp < cursor.oldestAt;
}

export function historyPageUrl(missionId: string, before: number | null, tail: number = CHAT_HISTORY_PAGE): string {
  const query = new URLSearchParams({ tail: String(tail) });
  if (before !== null) query.set('before', String(before));
  return `/api/ui/missions/${encodeURIComponent(missionId)}?${query.toString()}`;
}

/**
 * Older messages, built apart, go above the thread. A card has the same id in
 * both (`perm:<id>`, `cmd:<id>`…): one still waiting was replayed from the
 * prelude at the top of the newer list, and moves to its place in the older
 * one with the state the newer list holds.
 */
export function mergeOlderMessages<T extends { id: string }>(older: readonly T[], current: readonly T[]): T[] {
  if (!older.length) return current as T[];
  const byId = new Map(current.map((message) => [message.id, message]));
  const moved = new Set<string>();
  const head = older.map((message) => {
    const newer = byId.get(message.id);
    if (!newer) return message;
    moved.add(message.id);
    return newer;
  });
  return [...head, ...current.filter((message) => !moved.has(message.id))];
}

/** The context windows of the prelude, also under the short slug the gauge asks with. */
export function contextWindowsWithShortKeys(windows: Record<string, number>, short: (slug: string) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(windows)) {
    out[key] = value;
    out[short(key)] = value;
  }
  return out;
}
