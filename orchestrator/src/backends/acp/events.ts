/**
 * ACP `session/update` → Rooks's normalized vocabulary (the stream-json one:
 * `system:init`, `assistant`, `assistant_delta`, `user`, `result`).
 *
 * Pure mapping, no I/O: the driver feeds it `AcpTransport.onSessionUpdate`
 * params and the turn's `session/prompt` reply, and emits what comes out. It
 * speaks the vocabulary `streamJsonSpans` already understands, so tool spans
 * and the turn span come for free (`acpSpans` is that same function).
 *
 * What is stateful, and why the mapper is a per-session object:
 *  - `agent_thought_chunk`: an agent sends ~165 per turn (Hermes). They fold
 *    into ONE `{type:'thinking'}` block, emitted when something else happens.
 *    Persisting each fragment would blow up the events table; the UI already
 *    joins thinking blocks (`app/src/lib/thinking.ts`).
 *  - `agent_message_chunk`: streamed as ephemeral deltas, and the assembled text
 *    is persisted once as an `assistant` message (deltas are never stored).
 *  - `tool_call` / `tool_call_update`: an agent opens a call with an empty
 *    `rawInput` (opencode) and fills it in on the next update. The `tool_use`
 *    is held until it carries its input, so the span does not record `{}`.
 *  - `usage_update.cost` is cumulative for the session; a turn's cost is the
 *    difference to its start.
 *
 * Never throws: an unexpected payload yields `[]`. A missing line is a gap in
 * the transcript, an exception here kills the stream handler.
 */

import { randomUUID } from 'node:crypto';
import { ASSISTANT_DELTA, type AssistantDeltaPayload, type NormalizedEvent } from '../types.js';
import type { AcpRecord, AcpUsage } from './wire.js';

/** Reasoning kept per turn, bytes of text. Beyond it the block says so. */
const MAX_THOUGHT_CHARS = 256 * 1024;
const TRUNCATED_MARK = '\n…[reasoning truncated]';

/* ── Small readers ──────────────────────────────────────────────────────── */

function asRecord(v: unknown): AcpRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as AcpRecord) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Text of a `ContentBlock`; other kinds (image, resource link) have none. */
function blockText(content: unknown): string {
  const c = asRecord(content);
  return c && c.type === 'text' ? (str(c.text) ?? '') : '';
}

function isEmptyInput(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  const r = asRecord(v);
  return r !== null && Object.keys(r).length === 0;
}

/** Kind of an update (`agent_message_chunk`, …), null when the params are not
 *  a `session/update` payload. The driver uses it to recognise the history an
 *  agent replays on `session/load` (`user_message_chunk` and message chunks
 *  before the first prompt) without knowing the vocabulary. */
export function acpUpdateKind(params: unknown): string | null {
  return str(asRecord(asRecord(params)?.update)?.sessionUpdate);
}

/** The session a `session/update` belongs to. */
export function acpUpdateSessionId(params: unknown): string | null {
  const id = str(asRecord(params)?.sessionId);
  return id && id.length > 0 ? id : null;
}

/* ── Events built here ──────────────────────────────────────────────────── */

/** The `system:init` line every dialect opens a session with; `sessionId` is
 *  what gets persisted and passed back on resume. */
export function acpInitEvent(sessionId: string, backend = 'acp'): NormalizedEvent {
  return {
    type: 'system',
    payload: { type: 'system', subtype: 'init', session_id: sessionId, backend, mcp_servers: [], tools: [] },
  };
}

/** Same contract as the other dialects' `extractSessionId`. */
export function extractAcpSessionId(ev: NormalizedEvent): string | null {
  if (ev.type !== 'system') return null;
  const p = asRecord(ev.payload);
  if (!p || p.subtype !== 'init') return null;
  return typeof p.session_id === 'string' && p.session_id.length > 0 ? p.session_id : null;
}

function assistantEvent(content: unknown[]): NormalizedEvent {
  return {
    type: 'assistant',
    payload: { type: 'assistant', message: { id: randomUUID(), role: 'assistant', content } },
  };
}

function toolResultEvent(id: string, text: string, isError: boolean): NormalizedEvent {
  return {
    type: 'user',
    payload: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
    },
  };
}

/* ── Tool calls ─────────────────────────────────────────────────────────── */

type ToolState = {
  id: string;
  title: string | null;
  kind: string | null;
  status: string;
  rawInput: unknown;
  /** Text the agent attached (`content`) or its raw output, latest wins. */
  output: string | null;
  emitted: boolean;
  closed: boolean;
};

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/** `ToolCallContent[]` → text: the `content` entries' text, a diff as a path. */
function toolContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const r = asRecord(item);
    if (!r) continue;
    if (r.type === 'content') {
      const t = blockText(r.content);
      if (t) parts.push(t);
    } else if (r.type === 'diff' && str(r.path)) {
      parts.push(`diff: ${str(r.path)}`);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/** `rawOutput` as text: a string as is, `{output}` unwrapped, else its JSON. */
function rawOutputText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw;
  const r = asRecord(raw);
  const inner = r ? (str(r.output) ?? str(r.stdout)) : null;
  if (inner !== null) return inner;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

/** Display name of a call. `execute` with a `command` is a shell call: the
 *  chat and `humanize-tool` know it as `Bash`. Anything else keeps the agent's
 *  own words. */
export function toolName(t: { kind: string | null; title: string | null; rawInput: unknown }): string {
  const input = asRecord(t.rawInput);
  if (t.kind === 'execute' && typeof input?.command === 'string') return 'Bash';
  return t.title || t.kind || 'tool';
}

/* ── Turn outcome ───────────────────────────────────────────────────────── */

export type AcpTurnOutcome = {
  /** Reply of `session/prompt`. Absent = the agent gave none: a success is
   *  synthesized, the turn must end in one `result` either way. */
  stopReason?: string | null;
  usage?: AcpUsage | null;
  /** The turn failed (process died, request rejected). Wins over `stopReason`. */
  error?: string | null;
};

/** stopReasons that mean the agent gave up rather than finished. */
const FAILED_STOP_REASONS = new Set(['refusal', 'max_tokens', 'max_turn_requests']);

/* ── The mapper ─────────────────────────────────────────────────────────── */

export type AcpEventMapperOptions = {
  /** When set, updates of any other session are ignored. */
  sessionId?: string;
  /** Recorded in `system:init` and nothing else. */
  backend?: string;
};

export class AcpEventMapper {
  private readonly sessionId: string | undefined;

  private thought = '';
  private thoughtCut = false;
  private text = '';
  private lastText = '';
  private tools = new Map<string, ToolState>();
  private lastPlan = '';

  private cumulativeCost: number | null = null;
  private turnCostBase = 0;
  private context: { used: number; size: number } | null = null;
  private resulted = false;

  constructor(opts: AcpEventMapperOptions = {}) {
    this.sessionId = opts.sessionId;
  }

  /** Start of a turn: clears what belongs to one turn and pins the cost base.
   *  Calling it is optional for a first turn, required between turns. */
  beginTurn(): void {
    this.thought = '';
    this.thoughtCut = false;
    this.text = '';
    this.lastText = '';
    this.tools.clear();
    this.lastPlan = '';
    this.resulted = false;
    this.turnCostBase = this.cumulativeCost ?? 0;
  }

  /** Same signature as `AcpTransport.onSessionUpdate`'s params. */
  update(params: AcpRecord): NormalizedEvent[] {
    try {
      return this.mapUpdate(params);
    } catch {
      return [];
    }
  }

  /** End of turn: flushes what is buffered and emits the ONE `result`. A second
   *  call for the same turn returns `[]`. */
  finishTurn(outcome: AcpTurnOutcome = {}): NormalizedEvent[] {
    try {
      return this.mapFinish(outcome);
    } catch {
      return [];
    }
  }

  /* ── session/update ──────────────────────────────────────────────────── */

  private mapUpdate(params: AcpRecord): NormalizedEvent[] {
    const p = asRecord(params);
    const u = asRecord(p?.update);
    if (!p || !u) return [];
    const sid = str(p.sessionId);
    if (this.sessionId && sid && sid !== this.sessionId) return [];

    switch (str(u.sessionUpdate)) {
      case 'agent_message_chunk': {
        const text = blockText(u.content);
        if (!text) return [];
        const out = this.flushThought();
        this.text += text;
        out.push({ type: ASSISTANT_DELTA, payload: { text, mode: 'append' } satisfies AssistantDeltaPayload });
        return out;
      }
      case 'agent_thought_chunk': {
        const text = blockText(u.content);
        if (!text) return [];
        // Order matters in the transcript: the answer text so far precedes the
        // reasoning that follows it.
        const out = this.flushText();
        this.appendThought(text);
        return out;
      }
      case 'tool_call':
        return this.onToolCall(u);
      case 'tool_call_update':
        return this.onToolUpdate(u);
      case 'plan':
        return this.onPlan(u);
      case 'usage_update':
        this.onUsageUpdate(u);
        return [];
      default:
        // user_message_chunk (history replay), available_commands_update,
        // config_option_update, current_mode_update, session_info_update and
        // whatever a newer agent adds: none of it is conversation.
        return [];
    }
  }

  private appendThought(text: string): void {
    if (this.thoughtCut) return;
    const room = MAX_THOUGHT_CHARS - this.thought.length;
    if (text.length > room) {
      this.thought += text.slice(0, Math.max(0, room));
      this.thoughtCut = true;
    } else {
      this.thought += text;
    }
  }

  private flushThought(): NormalizedEvent[] {
    if (!this.thought.trim()) {
      this.thought = '';
      this.thoughtCut = false;
      return [];
    }
    const thinking = this.thought + (this.thoughtCut ? TRUNCATED_MARK : '');
    this.thought = '';
    this.thoughtCut = false;
    return [assistantEvent([{ type: 'thinking', thinking }])];
  }

  private flushText(): NormalizedEvent[] {
    if (!this.text) return [];
    const text = this.text;
    this.text = '';
    this.lastText = text;
    return [assistantEvent([{ type: 'text', text }])];
  }

  /** Everything buffered, in the order it was said. */
  private flushBuffers(): NormalizedEvent[] {
    return [...this.flushThought(), ...this.flushText()];
  }

  /* ── tools ───────────────────────────────────────────────────────────── */

  private toolFor(u: AcpRecord): ToolState | null {
    const id = str(u.toolCallId);
    if (!id) return null;
    let t = this.tools.get(id);
    if (!t) {
      t = { id, title: null, kind: null, status: 'pending', rawInput: undefined, output: null, emitted: false, closed: false };
      this.tools.set(id, t);
    }
    return t;
  }

  /** Fold an update's fields into the call. Absent fields change nothing: an
   *  update carries only what moved. */
  private merge(t: ToolState, u: AcpRecord): void {
    const title = str(u.title);
    if (title) t.title = title;
    const kind = str(u.kind);
    if (kind) t.kind = kind;
    const status = str(u.status);
    if (status) t.status = status;
    if (!isEmptyInput(u.rawInput)) t.rawInput = u.rawInput;
    const out = rawOutputText(u.rawOutput) ?? toolContentText(u.content);
    if (out !== null) t.output = out;
  }

  /** `tool_use` once the call is worth showing: it has its input, or it moved
   *  past `pending`, or the turn is over. */
  private emitToolUse(t: ToolState, force: boolean): NormalizedEvent[] {
    if (t.emitted) return [];
    const ready = force || !isEmptyInput(t.rawInput) || t.status !== 'pending';
    if (!ready) return [];
    t.emitted = true;
    const out = this.flushBuffers();
    out.push(assistantEvent([{
      type: 'tool_use',
      id: t.id,
      name: toolName(t),
      input: asRecord(t.rawInput) ?? (t.rawInput === undefined ? {} : { value: t.rawInput }),
      ...(t.title ? { title: t.title } : {}),
      ...(t.kind ? { acp_kind: t.kind } : {}),
    }]));
    return out;
  }

  private closeTool(t: ToolState): NormalizedEvent[] {
    if (t.closed || !TERMINAL_STATUSES.has(t.status)) return [];
    t.closed = true;
    return [toolResultEvent(t.id, t.output ?? '', t.status === 'failed')];
  }

  private onToolCall(u: AcpRecord): NormalizedEvent[] {
    const t = this.toolFor(u);
    if (!t) return [];
    this.merge(t, u);
    return [...this.emitToolUse(t, false), ...this.closeToolIfEmitted(t)];
  }

  private onToolUpdate(u: AcpRecord): NormalizedEvent[] {
    // An update for a call we never saw opened (a resumed stream) is a call.
    const t = this.toolFor(u);
    if (!t) return [];
    this.merge(t, u);
    return [...this.emitToolUse(t, false), ...this.closeToolIfEmitted(t)];
  }

  private closeToolIfEmitted(t: ToolState): NormalizedEvent[] {
    // A result without its tool_use would be an orphan in the transcript.
    return t.emitted ? this.closeTool(t) : [];
  }

  /* ── plan / usage ────────────────────────────────────────────────────── */

  /** The plan is a todo list: the chat renders Claude's `TodoWrite` as one, so
   *  the plan takes that shape (call and immediate result, one instantaneous
   *  span). A plan re-sent unchanged is not re-emitted. */
  private onPlan(u: AcpRecord): NormalizedEvent[] {
    if (!Array.isArray(u.entries)) return [];
    const todos: Array<{ content: string; status: string; activeForm: string }> = [];
    for (const e of u.entries) {
      const r = asRecord(e);
      const content = str(r?.content);
      if (!content) continue;
      const s = str(r?.status);
      todos.push({
        content,
        status: s === 'in_progress' || s === 'completed' ? s : 'pending',
        activeForm: content,
      });
    }
    if (todos.length === 0) return [];
    const key = JSON.stringify(todos);
    if (key === this.lastPlan) return [];
    this.lastPlan = key;
    const id = randomUUID();
    return [
      ...this.flushBuffers(),
      assistantEvent([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }]),
      toolResultEvent(id, 'plan updated', false),
    ];
  }

  private onUsageUpdate(u: AcpRecord): void {
    const used = num(u.used);
    const size = num(u.size);
    if (used !== null && size !== null) this.context = { used, size };
    const cost = asRecord(u.cost);
    // Only a USD amount is comparable to `total_cost_usd`; a token-priced
    // currency or a bare number of unknown unit is left out rather than guessed.
    if (cost) {
      const amount = num(cost.amount);
      const currency = str(cost.currency);
      if (amount !== null && (currency === null || currency.toUpperCase() === 'USD')) this.cumulativeCost = amount;
    }
  }

  /* ── end of turn ─────────────────────────────────────────────────────── */

  private mapFinish(outcome: AcpTurnOutcome): NormalizedEvent[] {
    if (this.resulted) return [];
    this.resulted = true;

    const out = this.flushBuffers();
    // Calls the agent never resolved: shown, and left open for the span layer
    // to close as interrupted.
    for (const t of this.tools.values()) out.push(...this.emitToolUse(t, true));

    const stop = outcome.stopReason ?? null;
    const failed = Boolean(outcome.error) || (stop !== null && FAILED_STOP_REASONS.has(stop));
    // A cumulative cost that went down means the agent restarted its counter.
    const cost = this.cumulativeCost === null
      ? 0
      : this.cumulativeCost >= this.turnCostBase ? this.cumulativeCost - this.turnCostBase : this.cumulativeCost;
    const u = outcome.usage;

    out.push({
      type: 'result',
      payload: {
        type: 'result',
        subtype: failed ? 'error' : stop === 'cancelled' ? 'cancelled' : 'success',
        is_error: failed,
        ...(failed ? { error: outcome.error ?? `agent stopped: ${stop}` } : {}),
        ...(this.lastText ? { result: this.lastText } : {}),
        ...(stop ? { stop_reason: stop } : {}),
        total_cost_usd: cost,
        ...(u ? {
          usage: {
            input_tokens: u.inputTokens,
            output_tokens: u.outputTokens,
            cache_read_input_tokens: u.cachedReadTokens,
            reasoning_tokens: u.thoughtTokens,
          },
        } : {}),
        ...(this.context ? { context_tokens: this.context.used, context_window: this.context.size } : {}),
      },
    });
    return out;
  }
}
