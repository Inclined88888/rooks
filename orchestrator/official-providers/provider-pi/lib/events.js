// @ts-check
/**
 * Pi's RPC session events → Timon's normalized vocabulary (the stream-json one: `assistant`,
 * `assistant_delta`, `user`, `result`, `provider_retry`), built with the daemon's own factories
 * (`runtime.events`) so tool and turn spans come for free (`declares.spans: 'stream-json'`).
 *
 * Pure mapping, no I/O, and it never throws: an unexpected record yields `[]`. Verified on Pi 1.4.0
 * (fixtures `src/official-providers/__fixtures__/pi-rpc/`).
 *
 * What it relies on, and why:
 *  - `message_end` of an assistant message is AUTHORITATIVE (Pi's docs): its content carries the
 *    whole text, the reasoning (`thinking`) and the tool calls (`toolCall`), in order, and its
 *    `usage` the tokens and the cost of that one LLM call. Only text is streamed before it
 *    (`text_delta`, ephemeral); a turn with tool calls holds several assistant messages.
 *  - `tool_execution_end` closes a call with its result. `tool_execution_start` only matters for a
 *    call no message announced (one an extension ran), and it comes BEFORE the permission gate
 *    decides: it is held until Pi proves the call runs (`tool_execution_update`, its end) or the
 *    card allowed it (`release`), so a refused call never shows as started.
 *  - A provider error is retried by Pi itself (`auto_retry_start`, three times by default): each
 *    attempt ends its own `agent_end`, only `agent_settled` ends the turn, and
 *    `auto_retry_end{success:false}` carries the final error.
 *
 * @typedef {import('@timon-ai/sdk/provider').NormalizedEvent} NormalizedEvent
 * @typedef {import('@timon-ai/sdk/provider').ProviderRuntime} ProviderRuntime
 * @typedef {Record<string, unknown>} PiRecord
 */
import { randomUUID } from 'node:crypto';

/** @param {unknown} v @returns {PiRecord | null} */
function asRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {PiRecord} */ (v) : null;
}

/** @param {unknown} v @returns {string | null} */
function str(v) {
  return typeof v === 'string' ? v : null;
}

/** @param {unknown} v @returns {number} */
function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Display name of a Pi tool. Pi's `bash` takes `{ command }`, the shape the chat and
 * `humanize-tool` know as `Bash`; the others keep Pi's own name, their arguments differ from
 * Claude Code's and would be rendered wrong under its names.
 * @param {string} name
 */
export function piToolName(name) {
  return name === 'bash' ? 'Bash' : name;
}

/**
 * The HTTP status at the head of a Pi provider error (`500: {"message":…}`), or null.
 * @param {string | null} message
 * @returns {number | null}
 */
export function piErrorStatus(message) {
  const match = message ? /^(\d{3})\b/.exec(message.trim()) : null;
  return match ? Number(match[1]) : null;
}

/** @param {unknown} content @returns {string} */
function toolResultText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const parts = [];
  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === 'text') parts.push(str(block.text) ?? '');
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

/** `stopReason`s after which the model wrote nothing more: a failure, not an answer. */
const FAILED_STOP_REASONS = new Set(['length']);

export class PiEventMapper {
  /** @param {ProviderRuntime} runtime */
  constructor(runtime) {
    this.events = runtime.events;
    /** @type {number | null} */
    this.contextWindow = null;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.cost = 0;
    this.lastText = '';
    /** @type {number | null} */
    this.contextTokens = null;
    /** @type {Set<string>} */
    this.toolsShown = new Set();
    /** Calls Pi announced before the gate decided, held back. @type {Map<string, { name: string, args: unknown }>} */
    this.toolsHeld = new Map();
    /** @type {string | null} */
    this.error = null;
    /** @type {string | null} */
    this.stopReason = null;
    this.resulted = false;
  }

  /** Clears what belongs to one turn. */
  beginTurn() {
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.cost = 0;
    this.lastText = '';
    this.contextTokens = null;
    this.toolsShown = new Set();
    this.toolsHeld = new Map();
    this.error = null;
    this.stopReason = null;
    this.resulted = false;
  }

  /**
   * The call the permission card just allowed, if Pi announced it and nothing showed it yet.
   * @param {string} id
   * @returns {NormalizedEvent[]}
   */
  release(id) {
    const held = this.toolsHeld.get(id);
    if (!held) return [];
    this.toolsHeld.delete(id);
    return this.showTool(id, held.name, held.args);
  }

  /** @param {unknown} model Pi's model object (`get_state`, `set_model`). */
  setModel(model) {
    const window = asRecord(model)?.contextWindow;
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) this.contextWindow = window;
  }

  /**
   * One session event of Pi's into 0..N normalized events.
   * @param {PiRecord} record
   * @returns {NormalizedEvent[]}
   */
  map(record) {
    try {
      return this.mapRecord(record);
    } catch {
      return [];
    }
  }

  /** @param {PiRecord} record @returns {NormalizedEvent[]} */
  mapRecord(record) {
    switch (record.type) {
      case 'message_update': {
        const update = asRecord(record.assistantMessageEvent);
        const delta = update?.type === 'text_delta' ? str(update.delta) : null;
        return delta ? [this.events.assistantDeltaEvent(delta)] : [];
      }
      case 'message_end':
        return this.onMessageEnd(asRecord(record.message));
      case 'tool_execution_start': {
        // Before the gate: shown once the call is known to run, never as started when refused.
        const id = str(record.toolCallId);
        if (id && !this.toolsShown.has(id)) this.toolsHeld.set(id, { name: str(record.toolName) ?? 'tool', args: record.args });
        return [];
      }
      case 'tool_execution_update': {
        const id = str(record.toolCallId);
        return id ? this.release(id) : [];
      }
      case 'tool_execution_end': {
        const id = str(record.toolCallId);
        if (!id) return [];
        this.toolsHeld.delete(id);
        const result = asRecord(record.result);
        return [
          // A result without its call would be an orphan in the transcript.
          ...this.showTool(id, str(record.toolName) ?? 'tool', record.args),
          this.events.toolResultEvent({ toolUseId: id, content: toolResultText(result?.content), isError: record.isError === true }),
        ];
      }
      case 'auto_retry_start': {
        const cause = str(record.errorMessage) ?? 'provider error';
        return [this.events.providerRetryEvent({
          attempt: typeof record.attempt === 'number' ? record.attempt : null,
          max: typeof record.maxAttempts === 'number' ? record.maxAttempts : null,
          cause,
          delayMs: typeof record.delayMs === 'number' ? record.delayMs : null,
          status: piErrorStatus(cause),
        })];
      }
      case 'auto_retry_end':
        if (record.success === false) this.error = str(record.finalError) ?? this.error ?? 'provider error';
        else if (record.success === true) this.error = null;
        return [];
      default:
        // agent_start/end, turn_start/end, message_start, queue_update, compaction and the rest:
        // either repeated by `message_end` or not conversation.
        return [];
    }
  }

  /** @param {PiRecord | null} message @returns {NormalizedEvent[]} */
  onMessageEnd(message) {
    if (!message || message.role !== 'assistant') return [];
    const usage = asRecord(message.usage);
    if (usage) {
      this.usage.input += count(usage.input);
      this.usage.output += count(usage.output);
      this.usage.cacheRead += count(usage.cacheRead);
      this.usage.cacheWrite += count(usage.cacheWrite);
      this.cost += count(asRecord(usage.cost)?.total);
      // What the model saw on this call, its own answer included: the context the next call starts from.
      const total = count(usage.totalTokens)
        || count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite);
      if (total > 0) this.contextTokens = total;
    }
    const stopReason = str(message.stopReason);
    if (stopReason) this.stopReason = stopReason;
    // An attempt that failed is followed by a retry: the last word is the one that counts.
    if (stopReason === 'error') this.error = str(message.errorMessage) ?? 'provider error';
    else if (stopReason && stopReason !== 'aborted') this.error = null;

    const id = randomUUID();
    /** @type {NormalizedEvent[]} */
    const out = [];
    for (const item of Array.isArray(message.content) ? message.content : []) {
      const block = asRecord(item);
      if (!block) continue;
      if (block.type === 'thinking') {
        const thinking = str(block.thinking);
        if (thinking && thinking.trim()) out.push(this.events.assistantThinkingEvent(thinking, id));
      } else if (block.type === 'text') {
        const text = str(block.text);
        if (text) {
          out.push(this.events.assistantTextEvent(text, id));
          this.lastText = text;
        }
      } else if (block.type === 'toolCall') {
        const callId = str(block.id);
        if (callId) out.push(...this.showTool(callId, str(block.name) ?? 'tool', block.arguments));
      }
    }
    return out;
  }

  /** @param {string} id @param {string} name @param {unknown} args @returns {NormalizedEvent[]} */
  showTool(id, name, args) {
    if (this.toolsShown.has(id)) return [];
    this.toolsShown.add(id);
    const input = asRecord(args) ?? (args === undefined || args === null ? {} : { value: args });
    return [this.events.toolUseEvent({ id, name: piToolName(name), input })];
  }

  /**
   * The ONE `result` of the turn. A second call for the same turn returns `[]`.
   * @param {{ aborted?: boolean, error?: string | null }} outcome
   * @returns {NormalizedEvent[]}
   */
  finish(outcome = {}) {
    if (this.resulted) return [];
    this.resulted = true;
    const aborted = outcome.aborted === true;
    const error = outcome.error
      ?? (aborted ? null : this.error)
      ?? (this.stopReason && FAILED_STOP_REASONS.has(this.stopReason) ? `the model stopped: ${this.stopReason}` : null);
    const status = piErrorStatus(error);
    return [{
      type: 'result',
      payload: {
        type: 'result',
        subtype: error ? 'error' : aborted ? 'cancelled' : 'success',
        is_error: Boolean(error),
        ...(error ? { error } : {}),
        ...(error && status !== null ? { api_error_status: status } : {}),
        ...(this.lastText ? { result: this.lastText } : {}),
        ...(this.stopReason ? { stop_reason: this.stopReason } : {}),
        total_cost_usd: this.cost,
        usage: {
          input_tokens: this.usage.input,
          output_tokens: this.usage.output,
          cache_read_input_tokens: this.usage.cacheRead,
          cache_creation_input_tokens: this.usage.cacheWrite,
        },
        ...(this.contextTokens !== null ? { context_tokens: this.contextTokens } : {}),
        ...(this.contextWindow !== null ? { context_window: this.contextWindow } : {}),
      },
    }];
  }
}
