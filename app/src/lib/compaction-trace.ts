/**
 * The compaction as the thread tells it (TODO #504): one discreet line per
 * operation, never a bubble of the human's.
 *
 * A native compaction leaves several rows in the mission (docs/MISSION-COMPACT.md):
 * the command Rooks sent (`user`, origin system/orchestrator), the CLI's
 * `compact_boundary`, two `user` rows the CLI writes itself — `isSynthetic`
 * (the summary it continues from) and `isReplay` (`Compacted`) — then the
 * daemon's `compact` outcome. A fork leaves only the outcome. They all fold
 * into the same trace.
 */

export type CompactionTraceView = {
  mode: 'native' | 'fork' | null;
  /** null = asked, nothing seen since (the daemon stopped, or it still runs). */
  outcome: 'done' | 'error' | null;
  /** The daemon's outcome row came: the next compaction opens a new trace. */
  final: boolean;
  /** The summary the CLI continues from (native), shown folded. */
  summary: string | null;
  preTokens: number | null;
  postTokens: number | null;
  error: string | null;
  /** Fork: the conversation the work continues in. */
  targetMissionId: string | null;
};

export type CompactionUser =
  | { kind: 'command' }
  | { kind: 'summary'; text: string }
  | { kind: 'ack' };

export const EMPTY_TRACE: CompactionTraceView = {
  mode: null, outcome: null, final: false, summary: null, preTokens: null, postTokens: null, error: null, targetMissionId: null,
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } =>
      !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** How Claude Code opens the summary it continues from, manual or automatic compaction alike. */
const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

/**
 * A `user` row the CLI wrote itself, never the human: a compaction summary,
 * but also the note on a resized image (`[Image: original …]`) or the body of
 * a skill it loaded (`Base directory for this skill: …`). Plumbing to keep
 * out of the thread, unless it is the summary.
 */
export function isCliSynthetic(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && (payload as Record<string, unknown>).isSynthetic === true;
}

/** A trace the CLI's boundary or Rooks's command opened, still without its summary. */
function awaitsSummary(trace: CompactionTraceView | null | undefined): boolean {
  return isOpenTrace(trace) && trace.summary === null;
}

/**
 * A `user` row that belongs to a compaction, or null for any other one.
 * The command is told by its sender AND its shape — a bare slash command
 * from the daemon — so a daemon prompt in prose stays a normal row.
 * A synthetic row is the summary by its opening words, or — should the CLI
 * reword them — by coming while `open`, the thread's last trace, still
 * waits for one; `isSynthetic` alone also marks image notes and skill bodies.
 */
export function readCompactionUser(payload: unknown, open?: CompactionTraceView | null): CompactionUser | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const message = p.message && typeof p.message === 'object' ? p.message as Record<string, unknown> : null;
  const text = textOf(message?.content).trim();
  if (p.isSynthetic === true) {
    return text.startsWith(SUMMARY_PREFIX) || awaitsSummary(open) ? { kind: 'summary', text } : null;
  }
  // `isReplay` is also how Claude Code echoes a typed message under
  // `--replay-user-messages`: only the local command's output is the ack.
  if (p.isReplay === true && text.includes('<local-command-stdout>')) return { kind: 'ack' };
  const origin = p.origin && typeof p.origin === 'object' ? p.origin as Record<string, unknown> : null;
  if (origin?.kind === 'system' && origin.from === 'orchestrator' && /^\/[\w-]+$/.test(text)) return { kind: 'command' };
  return null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** `compact_metadata` of a `system/compact_boundary` row, or null. */
export function readCompactBoundary(payload: unknown): { preTokens: number | null; postTokens: number | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'system' || p.subtype !== 'compact_boundary') return null;
  const meta = p.compact_metadata && typeof p.compact_metadata === 'object'
    ? p.compact_metadata as Record<string, unknown>
    : {};
  return { preTokens: num(meta.pre_tokens), postTokens: num(meta.post_tokens) };
}

/** The daemon's `compact` outcome row as a trace patch, or null. */
export function readCompactOutcome(payload: unknown): Partial<CompactionTraceView> | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.outcome !== 'done' && p.outcome !== 'error') return null;
  const meta = p.compact_metadata && typeof p.compact_metadata === 'object'
    ? p.compact_metadata as Record<string, unknown>
    : null;
  return {
    mode: p.mode === 'native' || p.mode === 'fork' ? p.mode : null,
    outcome: p.outcome,
    final: true,
    error: typeof p.error === 'string' && p.error ? p.error : null,
    targetMissionId: p.mode === 'fork' && typeof p.target_mission_id === 'string' ? p.target_mission_id : null,
    ...(meta ? { preTokens: num(meta.pre_tokens), postTokens: num(meta.post_tokens) } : {}),
  };
}

/** Folds a patch into a trace: what is already known is not erased by a row that does not carry it. */
export function foldTrace(trace: CompactionTraceView | null, patch: Partial<CompactionTraceView>): CompactionTraceView {
  const base = trace ?? EMPTY_TRACE;
  const next: CompactionTraceView = { ...base };
  for (const key of Object.keys(patch) as (keyof CompactionTraceView)[]) {
    const value = patch[key];
    if (value !== null && value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** A trace the daemon has not closed takes the next compaction rows. */
export function isOpenTrace(trace: CompactionTraceView | null | undefined): trace is CompactionTraceView {
  return !!trace && !trace.final;
}

/**
 * The patch a compaction `user` row brings. The CLI writes its summary and
 * its ack only once it has compacted: they say "done" on their own, so a
 * `/compact` typed by hand (no daemon outcome to follow) still ends its trace.
 */
export function userTracePatch(row: CompactionUser): Partial<CompactionTraceView> {
  if (row.kind === 'command') return {};
  return { mode: 'native', outcome: 'done', ...(row.kind === 'summary' && row.text ? { summary: row.text } : {}) };
}

/** Same for the CLI's boundary row. */
export function boundaryTracePatch(b: { preTokens: number | null; postTokens: number | null }): Partial<CompactionTraceView> {
  return { mode: 'native', outcome: 'done', preTokens: b.preTokens, postTokens: b.postTokens };
}
