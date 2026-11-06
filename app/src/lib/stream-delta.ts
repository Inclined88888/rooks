/**
 * Routing of the text fragments received on the SSE stream
 * (`event: event_delta`) while an answer is generated.
 *
 * This module is deliberately pure: the chat's `event_delta` handler lived
 * buried in a 4000-line component, so the only rules deciding whether a
 * fragment is shown or dropped could only be checked by eye. They are
 * extracted here to be locked by a test — the server chain (dialect → bus →
 * SSE) already is on its side
 * (`orchestrator/src/backends/streaming.test.ts`, `src/sse-delta.test.ts`).
 */

/** Type of the ephemeral event carried by an `event_delta` frame. */
export const ASSISTANT_DELTA = 'assistant_delta';

export type StreamDeltaAction =
  | { kind: 'ignore' }
  | { kind: 'push'; text: string; mode: 'append' | 'replace' };

const IGNORE: StreamDeltaAction = { kind: 'ignore' };

/**
 * Decides what to do with an already deserialised `event_delta` frame.
 *
 * @param frame            raw JSON payload of the frame (shape not guaranteed).
 * @param activeMissionId  mission currently shown, `null` if none.
 */
export function routeStreamDelta(
  frame: unknown,
  activeMissionId: string | null,
): StreamDeltaAction {
  if (frame === null || typeof frame !== 'object') return IGNORE;
  const ev = frame as { type?: unknown; missionId?: unknown; payload?: unknown };
  if (ev.type !== ASSISTANT_DELTA) return IGNORE;
  // The stream is already filtered by mission on the orchestrator side, but a
  // replaced EventSource can still deliver a frame in flight: showing the
  // text of another conversation would be a visible leak. `null` on the
  // client (no bound mission) must never match.
  if (!activeMissionId || ev.missionId !== activeMissionId) return IGNORE;
  const p = ev.payload as { text?: unknown; mode?: unknown } | null | undefined;
  if (typeof p?.text !== 'string' || p.text.length === 0) return IGNORE;
  return { kind: 'push', text: p.text, mode: p.mode === 'replace' ? 'replace' : 'append' };
}

/**
 * PERSISTED event types that close the current fragment. `assistant` is the
 * case that matters: it carries the full text the deltas were drawing, so
 * keeping the buffer one more frame would show it twice. `result` and `user`
 * cover the turns without streamed text.
 */
export function endsStreamingBubble(eventType: unknown): boolean {
  return eventType === 'assistant' || eventType === 'result' || eventType === 'user';
}

/** Applies an accepted fragment to a buffer. */
export function applyStreamDelta(
  buffer: string,
  action: Extract<StreamDeltaAction, { kind: 'push' }>,
): string {
  return action.mode === 'replace' ? action.text : buffer + action.text;
}
