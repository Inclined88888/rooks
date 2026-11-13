/**
 * Span normaliser for the stream-json vocabulary (docs/PRD-WORKFLOWS.md §4.1).
 *
 * Shared by the `claude` and `grok` dialects: grok's
 * `--output-format streaming-messages-json` emits claude's exact event shapes
 * (`assistant` with `content[]`, `user` carrying `tool_result`, a final
 * `result`), and the raw `stream_event` lines are already reduced to text
 * deltas by each dialect's `parseLine` — deltas never reach this function.
 * So one normaliser, no per-dialect fork to keep in sync.
 *
 * What opens / closes what:
 *
 *   turn      opened by the first `assistant` of a turn, closed by `result`
 *             (usage, cost, stop reason). The turn is the parent of every
 *             other span of the same turn.
 *   tool      opened by a `tool_use` block (`id` = the backend's tool_use_id,
 *             so a line replayed on `--resume` hits `INSERT OR IGNORE` and
 *             changes nothing), closed by the `tool_result` carrying the same
 *             id — `error` when the block says `is_error`.
 *   thinking  instantaneous, from a `thinking` block or a
 *             `system/thinking_tokens` line; `output` carries the token count
 *             (reported, or estimated at four characters per token).
 *
 * `input` / `output` go through the vault redaction BEFORE truncation, on the
 * deserialised value (a secret spanning a JSON escape would slip past a
 * textual pass), then are cut to `state.maxBytes` — `events` keeps the full
 * payload, the span is an index, not a copy.
 *
 * The function never throws on an unexpected payload: a line it does not
 * understand yields `[]`. A trace that misses a span is a gap; a trace that
 * kills the stream handler is an incident.
 */

import { randomUUID } from 'node:crypto';
import type { NormalizedEvent, OpenSpan, SpanOp, SpanState } from './types.js';
import { redactDeep } from '../secrets/redact.js';

/** Appended when a payload was cut, so a reader knows the value is partial. */
export const TRUNCATION_MARK = '…[truncated]';

/**
 * JSON of `value`, masked, bounded to `maxBytes` of UTF-8. The bound is on
 * the JSON text, not the structure: cutting a string mid-escape is fine for
 * an index nobody re-parses, and it keeps the cost linear in the payload.
 */
export function spanPayload(value: unknown, maxBytes: number): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    const masked = redactDeep(value);
    text = typeof masked === 'string' ? masked : JSON.stringify(masked);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Shrink by characters until the byte budget holds. Multi-byte text can
  // overshoot the first estimate, hence the loop; it converges in a few steps.
  let out = text.slice(0, maxBytes);
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return out + TRUNCATION_MARK;
}

type Block = Record<string, unknown>;

function contentBlocks(payload: unknown): Block[] {
  const msg = (payload as { message?: { content?: unknown } } | null)?.message;
  const content = msg?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => b !== null && typeof b === 'object');
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Text of a `tool_result` block: a plain string, or an array of text blocks. */
function toolResultContent(block: Block): unknown {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const texts = c
      .filter((b): b is Block => b !== null && typeof b === 'object' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length === c.length) return texts.join('\n');
  }
  return c ?? null;
}

/** Four characters per token: the usual rough estimate, good enough for a
 *  trace badge, and the only option when the CLI does not count for us. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function base(state: SpanState, seq: number, startedAt: number) {
  return {
    trace_id: state.traceId,
    mission_id: state.missionId,
    seq,
    started_at: startedAt,
    event_id_start: seq,
  };
}

function thinkingOp(state: SpanState, seq: number, now: number, tokens: number): SpanOp {
  return {
    op: 'open',
    id: randomUUID(),
    ...base(state, seq, now),
    kind: 'thinking',
    name: 'thinking',
    status: 'ok',
    ended_at: now,
    parent_span_id: state.turn?.id ?? null,
    output: JSON.stringify({ tokens }),
    event_id_end: seq,
  };
}

/** Cf. `Dialect.spans`. Exported for the two dialects and the tests. */
export function streamJsonSpans(ev: NormalizedEvent, state: SpanState, eventId: number): SpanOp[] {
  const now = Date.now();
  const ops: SpanOp[] = [];
  const payload = ev.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return ops;

  if (ev.type === 'assistant') {
    if (!state.turn) {
      const turn: OpenSpan = { id: randomUUID(), name: 'turn', seq: eventId, startedAt: now };
      state.turn = turn;
      ops.push({ op: 'open', id: turn.id, ...base(state, eventId, now), kind: 'turn', name: 'turn' });
    }
    for (const block of contentBlocks(payload)) {
      if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' && block.id ? block.id : randomUUID();
        const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
        const span: OpenSpan = { id, name, seq: eventId, startedAt: now };
        state.tools.set(id, span);
        ops.push({
          op: 'open', id, ...base(state, eventId, now), kind: 'tool', name,
          parent_span_id: state.turn.id,
          input: spanPayload(block.input, state.maxBytes),
        });
      } else if (block.type === 'thinking') {
        const text = typeof block.thinking === 'string' ? block.thinking : '';
        ops.push(thinkingOp(state, eventId, now, estimateTokens(text)));
      }
    }
    return ops;
  }

  if (ev.type === 'user') {
    for (const block of contentBlocks(payload)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const id = block.tool_use_id;
      const isError = block.is_error === true;
      const output = spanPayload(toolResultContent(block), state.maxBytes);
      // Closing an id we do not hold is still emitted: the store ignores an
      // unknown or already closed span, and this is what closes a tool span
      // opened by a process that died before its result came back.
      state.tools.delete(id);
      ops.push({
        op: 'close', id, status: isError ? 'error' : 'ok', ended_at: now,
        output, error: isError ? output : null, event_id_end: eventId,
      });
    }
    return ops;
  }

  if (ev.type === 'result') {
    const usage = payload.usage as Record<string, unknown> | undefined;
    const isError = payload.is_error === true;
    // A tool still open at the end of the turn never got its result (denied
    // permission, CLI cut short): it did not succeed, it was interrupted.
    for (const id of state.tools.keys()) {
      ops.push({
        op: 'close', id, status: 'interrupted', ended_at: now,
        error: 'no tool_result before the end of the turn', event_id_end: eventId,
      });
    }
    state.tools.clear();
    if (state.turn) {
      const resultText = typeof payload.result === 'string' ? payload.result : null;
      ops.push({
        op: 'close', id: state.turn.id, status: isError ? 'error' : 'ok', ended_at: now,
        tokens_in: asNumber(usage?.input_tokens),
        tokens_out: asNumber(usage?.output_tokens),
        cost_usd: asNumber(payload.total_cost_usd),
        output: spanPayload({
          subtype: payload.subtype ?? null,
          stop_reason: payload.stop_reason ?? null,
          num_turns: payload.num_turns ?? null,
          duration_api_ms: payload.duration_api_ms ?? null,
        }, state.maxBytes),
        error: isError ? spanPayload(resultText ?? payload.errors ?? 'error', state.maxBytes) : null,
        event_id_end: eventId,
      });
      state.turn = null;
    }
    return ops;
  }

  if (ev.type === 'system' && payload.subtype === 'thinking_tokens') {
    const tokens = asNumber(payload.thinking_tokens) ?? asNumber(payload.tokens) ?? asNumber(payload.count) ?? 0;
    ops.push(thinkingOp(state, eventId, now, tokens));
    return ops;
  }

  return ops;
}
