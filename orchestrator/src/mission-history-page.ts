/**
 * `GET /api/missions/:id?tail=N[&before=<eventId>]`: the chat view of a
 * mission read from its end, one page at a time. `?after=<eventId>`: what
 * came after a conversation the chat already holds (its client cache).
 *
 * The chat mounts its last 60 messages, yet used to download and replay the
 * whole journal. A page alone is not enough, though: `ingest()` carries state
 * from one event to the next (inventory: docs/MISSION-HISTORY-PAGES.md § 1).
 * So the tail page comes with its `prelude` — what the rows before it would
 * have left behind — and an older page with the later `resolutions` of the
 * cards it holds.
 *
 * Every condition below is a constant of this module; request values only
 * ever reach SQL as bound parameters.
 */
import { z } from 'zod';
import { dbApi, type EventRow } from './db.js';
import { CHAT_VIEW_SQL, INIT_PREFIX, INIT_ROW_SQL, keepLatestState, likeContains } from './mission-events-view.js';

/** Rows of a page when `before=` comes without `tail=`. */
export const HISTORY_PAGE_DEFAULT = 300;
export const HISTORY_PAGE_MAX = 2000;
/** Rows a page may grow by to keep each `tool_result` with its `tool_use`. */
export const ALIGN_MAX_EXTRA = 500;
const ALIGN_CHUNK = 100;

/** Rows a delta may carry. Beyond, a fresh tail page costs the chat less
 *  than replaying the delta over its cache: the answer is a `reset`. */
export const DELTA_MAX = HISTORY_PAGE_DEFAULT;

export const HistoryQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
  before: z.coerce.number().int().min(1).optional(),
  after: z.coerce.number().int().min(1).optional(),
}).refine((query) => query.after === undefined || (query.tail === undefined && query.before === undefined), {
  message: 'after excludes tail and before',
});

export interface HistoryQuery {
  tail: number;
  /** Rows strictly older than this event id; `null` = the end of the journal. */
  before: number | null;
}

/** Rows strictly newer than this event id. */
export interface HistoryDeltaQuery { after: number }

/** The paging asked for, `null` when none (the whole journal), or the zod issues. */
export function parseHistoryQuery(query: unknown):
  | { ok: true; value: HistoryQuery | HistoryDeltaQuery | null }
  | { ok: false; issues: string[] } {
  const parsed = HistoryQuerySchema.safeParse(query);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  }
  const { tail, before, after } = parsed.data;
  if (after !== undefined) return { ok: true, value: { after } };
  if (tail === undefined && before === undefined) return { ok: true, value: null };
  return { ok: true, value: { tail: tail ?? HISTORY_PAGE_DEFAULT, before: before ?? null } };
}

export function isDeltaQuery(query: HistoryQuery | HistoryDeltaQuery): query is HistoryDeltaQuery {
  return 'after' in query;
}

type Json = Record<string, unknown>;

function parse(payload: string): Json | null {
  try {
    const value: unknown = JSON.parse(payload);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function contentBlocks(payload: Json): Json[] {
  const content = record(payload.message)?.content;
  return Array.isArray(content) ? content.map(record).filter((b): b is Json => b !== null) : [];
}

interface ToolLinks { uses: string[]; results: string[] }
const NO_LINKS: ToolLinks = { uses: [], results: [] };

/** The `tool_use` ids an assistant row opens and the ones a user row answers.
 *  Sub-agent rows are left out, as the chat leaves them out. */
function toolLinks(row: EventRow): ToolLinks {
  if ((row.type !== 'assistant' && row.type !== 'user') || !row.payload.includes('"tool_')) return NO_LINKS;
  const payload = parse(row.payload);
  if (!payload || payload.parent_tool_use_id) return NO_LINKS;
  const links: ToolLinks = { uses: [], results: [] };
  for (const block of contentBlocks(payload)) {
    if (row.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') links.uses.push(block.id);
    if (row.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') links.results.push(block.tool_use_id);
  }
  return links;
}

const isStateRow = (row: EventRow): boolean => row.type === 'rate_limit_event'
  || (row.type === 'system' && row.payload.startsWith(INIT_PREFIX));

export interface HistoryPage {
  /** Oldest first. */
  rows: EventRow[];
  has_more: boolean;
  oldest_event_id: number | null;
}

function chatRowsBelow(missionId: string, below: number, limit: number): EventRow[] {
  return dbApi.scanMissionEvents(missionId, {
    where: `id < ? AND ${CHAT_VIEW_SQL}`, params: [below], order: 'DESC', limit,
  }) as EventRow[];
}

/**
 * The newest `tail` chat-view rows older than `before`, oldest first.
 *
 * A `tool_result` attaches to the `tool_use` of an earlier bubble: cut between
 * the two and the result is lost for good, since the older bubble is built
 * later, from another page. So the page grows into the past until it holds
 * the `tool_use` of every `tool_result` it carries, by at most
 * {@link ALIGN_MAX_EXTRA} rows.
 *
 * The tail page keeps only the last `init` / `rate_limit_event` (the chat view
 * rule); an older page drops them all, the prelude already said the state.
 */
export function readHistoryPage(missionId: string, query: HistoryQuery): HistoryPage {
  const below = query.before ?? Number.MAX_SAFE_INTEGER;
  const newest = chatRowsBelow(missionId, below, query.tail + 1);
  let hasMore = newest.length > query.tail;
  const page = newest.slice(0, query.tail).reverse();
  const links = new Map<number, ToolLinks>();
  const linksOf = (row: EventRow): ToolLinks => {
    let found = links.get(row.id);
    if (!found) {
      found = toolLinks(row);
      links.set(row.id, found);
    }
    return found;
  };
  const opened = new Set<string>();
  for (const row of page) for (const id of linksOf(row).uses) opened.add(id);
  const missing = new Set<string>();
  for (const row of page) for (const id of linksOf(row).results) if (!opened.has(id)) missing.add(id);
  let extra = 0;
  while (missing.size && hasMore && extra < ALIGN_MAX_EXTRA && page.length) {
    const chunk = chatRowsBelow(missionId, page[0]!.id, ALIGN_CHUNK + 1);
    const usable = chunk.slice(0, ALIGN_CHUNK);
    let taken = 0;
    while (taken < usable.length && missing.size && extra < ALIGN_MAX_EXTRA) {
      const row = usable[taken]!;
      page.unshift(row);
      taken += 1;
      extra += 1;
      const rowLinks = linksOf(row);
      for (const id of rowLinks.uses) missing.delete(id);
      // An older answer points further back still.
      for (const id of rowLinks.results) missing.add(id);
    }
    hasMore = taken < usable.length || chunk.length > ALIGN_CHUNK;
    if (!usable.length) break;
  }
  const rows = query.before === null ? keepLatestState(page) : page.filter((row) => !isStateRow(row));
  return { rows, has_more: hasMore, oldest_event_id: page[0]?.id ?? null };
}

export interface HistoryDelta {
  /** Oldest first; empty on a reset. */
  rows: EventRow[];
  /** More than {@link DELTA_MAX} rows came after: the caller rebuilds from a tail page. */
  reset: boolean;
  /** Id of the newest row read, the next `after`; `null` when nothing came. */
  newest_event_id: number | null;
}

/**
 * The chat-view rows strictly newer than `after`, for a conversation the chat
 * already holds up to that row. Unlike a page, nothing is carried apart: every
 * state the rows move was built by the client from the rows it holds. Only
 * the last `init` / `rate_limit_event` stays (the chat view rule), the order
 * is kept, so a `backend_switch` after the last `init` still wins.
 */
export function readHistoryDelta(missionId: string, after: number): HistoryDelta {
  const rows = dbApi.scanMissionEvents(missionId, {
    where: `id > ? AND ${CHAT_VIEW_SQL}`, params: [after], order: 'ASC', limit: DELTA_MAX + 1,
  }) as EventRow[];
  if (rows.length > DELTA_MAX) return { rows: [], reset: true, newest_event_id: null };
  return { rows: keepLatestState(rows), reset: false, newest_event_id: rows.at(-1)?.id ?? null };
}

/** What the rows before a tail page left behind (docs/MISSION-HISTORY-PAGES.md § 1). */
export interface HistoryPrelude {
  session_id: string | null;
  /** `missionBackend` / `missionModel` at the cut: the override, then the switches before it. */
  backend: string | null;
  model: string | null;
  /** The model the runtime reported (`liveStats.model`). */
  observed_model: string | null;
  stats: { tok: number; cost: number };
  totals: { in: number; out: number };
  /** `contextWindow` per model key, raw keys (the client adds their short form). */
  context_windows: Record<string, number>;
  last_context_tokens: number;
  /** What Retry replays: the human's own last words. */
  last_human_text: string | null;
  /** Todo tool calls since the last `TodoWrite`, oldest first. */
  todo_tool_uses: Array<{ id: string; name: string; input: Json }>;
  /** Rows replayed before the page as they are: the last rate limit of each
   *  window, and the cards still waiting for an answer. */
  events: EventRow[];
}

const TODO_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskStop'] as const;

/** Card requests and what settles them; ids are the payload's `id`. */
const CARD_REQUESTS = ['permission_request', 'command_request', 'ui_document', 'layout_proposal', 'setup_avatar_request', 'secret_request'] as const;
const CARD_RESOLUTIONS = [
  'permission_resolved', 'permission_expired', 'command_request_resolved',
  'ui_document_resolved', 'layout_proposal_resolved', 'setup_avatar_answered',
  'secret_request_resolved',
] as const;
/** Updates that move a card without settling it. */
const CARD_UPDATES = ['permission_timeout_adapted'] as const;
const ANNOTATION_STATUS = 'annotation_status';

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/**
 * Every row this module reads is a chat-view row, so every scan carries
 * `CHAT_VIEW_SQL`: it changes no result, and lets SQLite walk the partial
 * index of those rows instead of the per-token noise of a long mission
 * (db.ts `CHAT_VIEW_INDEX`, docs/MISSION-HISTORY-PAGES.md § 8).
 */
function scan<T>(missionId: string, where: string, params: (string | number)[], order: 'ASC' | 'DESC', extra: { limit?: number; columns?: string } = {}): T[] {
  return dbApi.scanMissionEvents(missionId, { where: `(${where}) AND ${CHAT_VIEW_SQL}`, params, order, ...extra }) as T[];
}

function lastContextTokens(missionId: string, cut: number): number {
  type Row = { type: string; sub: string | null; tin: number | null; tread: number | null; tmake: number | null; ctx: number | null };
  const rows = scan<Row>(missionId, `id < ? AND type IN ('assistant', 'result')`, [cut], 'DESC', {
    limit: 50,
    columns: `id, type, json_extract(payload, '$.parent_tool_use_id') AS sub,
      json_extract(payload, '$.message.usage.input_tokens') AS tin,
      json_extract(payload, '$.message.usage.cache_read_input_tokens') AS tread,
      json_extract(payload, '$.message.usage.cache_creation_input_tokens') AS tmake,
      json_extract(payload, '$.context_tokens') AS ctx`,
  });
  for (const row of rows) {
    if (row.type === 'assistant') {
      if (row.sub) continue;
      const snapshot = num(row.tin) + num(row.tread) + num(row.tmake);
      if (snapshot > 0) return snapshot;
    } else if (num(row.ctx) > 0) {
      return num(row.ctx);
    }
  }
  return 0;
}

/** The words a typed `user` row carries, `null` when it is not one. */
function typedText(row: EventRow): string | null {
  const payload = parse(row.payload);
  if (!payload || payload.parent_tool_use_id || payload.origin) return null;
  const raw = record(payload.message)?.content;
  const typed = typeof raw === 'string' ? raw
    : Array.isArray(raw) ? raw.map(record).filter((b): b is Json => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
      : '';
  return typed.trim() ? typed : null;
}

/** Id of the newest typed `user` row in `[from, cut)`, `null` when none. */
function lastHumanRow(missionId: string, from: number, cut: number): number | null {
  // Cheap filters first: a typed message has no `origin` key and answers no
  // tool. Both strings are JSON keys, which escaped user text cannot forge.
  const filter = `id >= ? AND id < ? AND type = 'user' AND payload NOT LIKE ${likeContains('"origin":')} AND payload NOT LIKE ${likeContains('"tool_result"')}`;
  let below = cut;
  for (;;) {
    const rows = scan<EventRow>(missionId, filter, [from, below], 'DESC', { limit: 20 });
    for (const row of rows) if (typedText(row) !== null) return row.id;
    if (rows.length < 20) return null;
    below = rows.at(-1)!.id;
  }
}

type TodoUses = HistoryPrelude['todo_tool_uses'];

/** Folds the todo tool calls of `[from, cut)` onto `uses`. */
function foldTodoToolUses(missionId: string, uses: TodoUses, from: number, cut: number): TodoUses {
  const named = TODO_TOOLS.map((name) => `payload LIKE ${likeContains(`"name":"${name}"`)}`).join(' OR ');
  const rows = scan<EventRow>(missionId, `id >= ? AND id < ? AND type = 'assistant' AND (${named})`, [from, cut], 'ASC');
  let folded = uses;
  for (const row of rows) {
    const payload = parse(row.payload);
    if (!payload || payload.parent_tool_use_id) continue;
    for (const block of contentBlocks(payload)) {
      if (block.type !== 'tool_use' || !(TODO_TOOLS as readonly unknown[]).includes(block.name)) continue;
      const use = { id: typeof block.id === 'string' ? block.id : '', name: block.name as string, input: record(block.input) ?? {} };
      // TodoWrite replaces the whole list: nothing before it matters.
      folded = use.name === 'TodoWrite' ? [use] : [...folded, use];
    }
  }
  return folded;
}

/**
 * What the prelude reads from the payload of every row before the cut: todo
 * calls, the last typed words, the `result` totals. Each opening of a long
 * mission used to sweep its whole journal for them, `LIKE` over every
 * `assistant` payload (thinking blocks of several hundred kilobytes included);
 * the fold is kept per mission, so the next opening reads only the rows that
 * came after it. The journal is append-only (ids only grow, the cold archive
 * keeps them), which is what makes the fold exact.
 *
 * It is also stored, so a daemon restart does not bring the sweep back: those
 * reads are what weighs on a cold disk, and better-sqlite3 holds the whole
 * daemon while they run (measures: docs/MISSION-HISTORY-PAGES.md § 6).
 */
interface PreludeFold {
  /** Rows with `id < upTo` are folded in. */
  upTo: number;
  todo: TodoUses;
  /** Kept as a row id, not as text: a pasted prompt can weigh megabytes. */
  humanRowId: number | null;
  stats: { tok: number; cost: number };
  totals: { in: number; out: number };
  contextWindows: Record<string, number>;
}

/** Missions whose fold stays in memory, least recently opened evicted first. */
export const PRELUDE_FOLD_CACHE_MAX = 200;
const preludeFolds = new Map<string, PreludeFold>();

const emptyFold = (): PreludeFold => ({
  upTo: 0, todo: [], humanRowId: null, stats: { tok: 0, cost: 0 }, totals: { in: 0, out: 0 }, contextWindows: {},
});

/** Bump when what a fold holds or how it is computed changes: a stored fold of
 *  another version would otherwise stay wrong for good, and is rebuilt instead. */
export const PRELUDE_FOLD_VERSION = 1;

const StoredFoldSchema = z.object({
  todo: z.array(z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })),
  humanRowId: z.number().int().nullable(),
  stats: z.object({ tok: z.number(), cost: z.number() }),
  totals: z.object({ in: z.number(), out: z.number() }),
  contextWindows: z.record(z.string(), z.number()),
});

/** The stored fold, `null` when there is none worth trusting: the journal can
 *  always rebuild it, so a bad row costs one sweep and never fails an opening. */
function loadStoredFold(missionId: string): PreludeFold | null {
  try {
    const stored = dbApi.getMissionPreludeFold(missionId);
    if (!stored || stored.version !== PRELUDE_FOLD_VERSION) return null;
    const state = StoredFoldSchema.safeParse(parse(stored.state));
    return state.success ? { upTo: stored.up_to, ...state.data } : null;
  } catch (err) {
    console.warn(`[missions] prelude fold of ${missionId} not read: ${(err as Error).message}`);
    return null;
  }
}

/** Opening a chat is a read: a fold that cannot be saved must not fail it. */
function storeFold(missionId: string, fold: PreludeFold): void {
  const { upTo, ...state } = fold;
  try {
    dbApi.setMissionPreludeFold(missionId, PRELUDE_FOLD_VERSION, upTo, JSON.stringify(state));
  } catch (err) {
    console.warn(`[missions] prelude fold of ${missionId} not saved: ${(err as Error).message}`);
  }
}

function extendFold(missionId: string, base: PreludeFold, cut: number): PreludeFold {
  const from = base.upTo;
  const fold: PreludeFold = {
    upTo: cut,
    todo: foldTodoToolUses(missionId, base.todo, from, cut),
    humanRowId: lastHumanRow(missionId, from, cut) ?? base.humanRowId,
    stats: { ...base.stats },
    totals: { ...base.totals },
    contextWindows: { ...base.contextWindows },
  };
  type Result = { cost: number | null; tin: number | null; tout: number | null; mu: string | null };
  const results = scan<Result>(missionId, `id >= ? AND id < ? AND type = 'result'`, [from, cut], 'ASC', {
    columns: `id, json_extract(payload, '$.total_cost_usd') AS cost,
      json_extract(payload, '$.usage.input_tokens') AS tin,
      json_extract(payload, '$.usage.output_tokens') AS tout,
      json_extract(payload, '$.modelUsage') AS mu`,
  });
  for (const r of results) {
    fold.stats.tok += num(r.tin) + num(r.tout);
    fold.stats.cost += num(r.cost);
    fold.totals.in += num(r.tin);
    fold.totals.out += num(r.tout);
    const usage = r.mu ? parse(r.mu) : null;
    for (const [key, value] of Object.entries(usage ?? {})) {
      const window = record(value)?.contextWindow;
      if (typeof window !== 'number' || window <= 0) continue;
      fold.contextWindows[key] = window;
      const canonical = text(record(value)?.canonicalModel);
      if (canonical) fold.contextWindows[canonical] = window;
    }
  }
  return fold;
}

function rememberFold(missionId: string, fold: PreludeFold): void {
  preludeFolds.delete(missionId);
  preludeFolds.set(missionId, fold);
  while (preludeFolds.size > PRELUDE_FOLD_CACHE_MAX) {
    const oldest = preludeFolds.keys().next().value;
    if (oldest === undefined) break;
    preludeFolds.delete(oldest);
  }
}

/** The fold of every row before `cut`, read from where the last opening stopped. */
function preludeFold(missionId: string, cut: number): PreludeFold {
  const known = preludeFolds.get(missionId) ?? loadStoredFold(missionId);
  // A cut behind the known one (a wider tail asked later) cannot be un-folded:
  // it is read whole, and the further fold stays.
  if (known && known.upTo > cut) {
    rememberFold(missionId, known);
    return extendFold(missionId, emptyFold(), cut);
  }
  const fold = known && known.upTo === cut ? known : extendFold(missionId, known ?? emptyFold(), cut);
  if (fold !== known) storeFold(missionId, fold);
  rememberFold(missionId, fold);
  return fold;
}

/** Forget the folds held in memory, as a daemon restart does; the stored ones stay (tests). */
export function clearPreludeFolds(): void {
  preludeFolds.clear();
}

/** Cards requested before `cut` and settled nowhere in the journal, with their updates. */
function pendingCards(missionId: string, cut: number): EventRow[] {
  type Req = { id: number; card: string | null; status: string | null };
  const requests = scan<Req>(missionId, `id < ? AND type IN (${sqlList(CARD_REQUESTS)})`, [cut], 'ASC', {
    columns: `id, json_extract(payload, '$.id') AS card, json_extract(payload, '$.status') AS status`,
  });
  const open = requests.filter((r) => typeof r.card === 'string' && (r.status === null || r.status === 'pending'));
  if (!open.length) return [];
  const settled = new Set(scan<{ card: unknown }>(missionId, `type IN (${sqlList(CARD_RESOLUTIONS)})`, [], 'ASC', {
    columns: `id, json_extract(payload, '$.id') AS card`,
  }).map((r) => r.card));
  const waiting = open.filter((r) => !settled.has(r.card));
  if (!waiting.length) return [];
  const ids = new Set<unknown>(waiting.map((r) => r.card));
  const rows = waiting.flatMap((r) => scan<EventRow>(missionId, 'id = ?', [r.id], 'ASC'));
  const updates = scan<EventRow>(missionId, `id < ? AND type IN (${sqlList(CARD_UPDATES)})`, [cut], 'ASC')
    .filter((row) => ids.has(parse(row.payload)?.id));
  return [...rows, ...updates];
}

function lastRateLimits(missionId: string, cut: number): EventRow[] {
  const rows = scan<EventRow>(missionId, `id < ? AND type = 'rate_limit_event'`, [cut], 'DESC', { limit: 200 });
  const seen = new Set<string>();
  const kept: EventRow[] = [];
  for (const row of rows) {
    const kind = record(parse(row.payload)?.rate_limit_info)?.rateLimitType;
    const key = typeof kind === 'string' ? kind : '';
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept.reverse();
}

/** The state a full replay would hold just before event `cut`. */
export function readHistoryPrelude(
  missionId: string,
  cut: number,
  overrides: { backend: string | null; model: string | null },
): HistoryPrelude {
  let backend = overrides.backend;
  let model = overrides.model;
  let observed: string | null = null;
  let sessionId: string | null = null;
  // Only the last `init` matters (about 11 kB each, one per resumed turn);
  // the switches around it are few and must be applied in order.
  const [lastInit] = scan<EventRow>(missionId, `id < ? AND ${INIT_ROW_SQL}`, [cut], 'DESC', { limit: 1 });
  const switches = scan<EventRow>(missionId, `id < ? AND type IN ('model_switch', 'backend_switch')`, [cut], 'ASC');
  const timeline = lastInit ? [...switches, lastInit].sort((a, b) => a.id - b.id) : switches;
  for (const row of timeline) {
    const p = parse(row.payload);
    if (!p) continue;
    if (row.type === 'system') {
      sessionId = text(p.session_id) ?? sessionId;
      observed = text(p.model) ?? observed;
    } else if (row.type === 'model_switch') {
      const next = text(p.model);
      if (!next) continue;
      model = next;
      if (p.status === 'applied') observed = next;
    } else {
      const next = text(p.backend);
      if (!next) continue;
      backend = next;
      model = text(p.model) ?? model;
      observed = text(p.model);
    }
  }
  const fold = preludeFold(missionId, cut);
  const [human] = fold.humanRowId === null ? [] : scan<EventRow>(missionId, 'id = ?', [fold.humanRowId], 'ASC');
  const events = [...lastRateLimits(missionId, cut), ...pendingCards(missionId, cut)].sort((a, b) => a.id - b.id);
  return {
    session_id: sessionId,
    backend,
    model,
    observed_model: observed,
    stats: { ...fold.stats },
    totals: { ...fold.totals },
    context_windows: { ...fold.contextWindows },
    last_context_tokens: lastContextTokens(missionId, cut),
    last_human_text: human ? typedText(human) : null,
    todo_tool_uses: fold.todo,
    events,
  };
}

/**
 * Later updates of the cards an older page holds: they were replayed with a
 * newer page, when the card was not loaded yet, and found nothing to move.
 * `annotation_status` rows follow too (they move a posted batch by its id).
 */
export function readLaterResolutions(missionId: string, page: readonly EventRow[]): EventRow[] {
  const newest = page[page.length - 1]?.id;
  if (newest === undefined) return [];
  const cards = new Set<unknown>();
  for (const row of page) {
    if ((CARD_REQUESTS as readonly string[]).includes(row.type)) cards.add(parse(row.payload)?.id);
  }
  const types = cards.size ? [...CARD_RESOLUTIONS, ...CARD_UPDATES, ANNOTATION_STATUS] : [ANNOTATION_STATUS];
  return scan<EventRow>(missionId, `id > ? AND type IN (${sqlList(types)})`, [newest], 'ASC', { limit: 1000 })
    .filter((row) => row.type === ANNOTATION_STATUS || cards.has(parse(row.payload)?.id));
}
