/**
 * Writes trace spans as the stream flows (docs/PRD-WORKFLOWS.md §4.2).
 *
 * `processEvent` calls `recordSpans` right after `insertEvent`, on the same
 * tick and the same connection. The invariant that matters (§12.1): a span
 * write that fails changes NOTHING for the mission — not its events, not its
 * exit code, not its lifecycle. The trace is an index over `events`; losing
 * an entry of the index is a gap, throwing here would kill the stdout handler
 * of a live agent. Hence the `try/catch` around the whole thing, dialect
 * normalisation included, and a single `console.warn`.
 */

import { dbApi, type SpanRow } from './db.js';
import type { Backend, NormalizedEvent, SpanState } from './backends/types.js';
import { settingInt } from './settings.js';

export function newSpanState(missionId: string, traceId: string): SpanState {
  return {
    missionId,
    traceId,
    turn: null,
    tools: new Map(),
    maxBytes: Math.max(64, settingInt('ROOKS_TRACE_SPAN_MAX_BYTES')),
  };
}

/**
 * State of a mission about to (re)start a process: its trace id, plus the
 * spans still `running` from a previous process (crash, `--resume`, the
 * one-shot re-spawn of a codex/grok turn). A tool span left open by a dead
 * process is then closed by the `tool_result` the resumed CLI replays; a
 * turn left open is closed by the next `result` instead of a second turn
 * being stacked on top of it.
 *
 * Never throws: a mission with no row (tests, a race with a delete) gets a
 * fresh state rooted at its own id, which is what `createMission` would
 * have written anyway.
 */
export function loadSpanState(missionId: string): SpanState {
  let traceId = missionId;
  let rows: SpanRow[] = [];
  try {
    traceId = dbApi.getMission(missionId)?.trace_id ?? missionId;
    rows = dbApi.listSpans(missionId).filter((s) => s.status === 'running');
  } catch (err) {
    console.warn(`[trace:${missionId.slice(0, 8)}] span state not loaded: ${(err as Error).message}`);
  }
  const state = newSpanState(missionId, traceId);
  for (const row of rows) {
    const span = { id: row.id, name: row.name, seq: row.seq, startedAt: row.started_at };
    if (row.kind === 'turn') {
      // Several open turns can only come from a bug; keep the latest, the
      // one the next `result` most plausibly belongs to.
      if (!state.turn || row.seq > state.turn.seq) state.turn = span;
    } else if (row.kind === 'tool') {
      state.tools.set(row.id, span);
    }
  }
  return state;
}

/**
 * Normalise `ev` through the backend and persist the resulting ops.
 * Returns the number of rows actually changed — `0` on a backend without
 * `spans`, on an event that opens or closes nothing, AND on failure: the
 * caller has nothing to decide on it, the number is for tests.
 */
export function recordSpans(
  backend: Pick<Backend, 'name' | 'spans'>,
  state: SpanState,
  ev: NormalizedEvent,
  eventId: number,
): number {
  if (!backend.spans) return 0;
  try {
    const ops = backend.spans(ev, state, eventId);
    if (!ops.length) return 0;
    const { opened, closed } = dbApi.upsertSpans(ops);
    return opened + closed;
  } catch (err) {
    console.warn(
      `[trace:${state.missionId.slice(0, 8)}] span write failed on ${ev.type}: ${(err as Error).message}`,
    );
    return 0;
  }
}
