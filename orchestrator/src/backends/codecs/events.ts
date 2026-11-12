/**
 * The vocabulary every provider writes its stream in, and the factories that
 * build it. The downstream of Rooks (the events table, the bus, the chat, the
 * usage-limit detector) is structured on the stream-json vocabulary of Claude
 * Code; a CLI that speaks anything else rewrites its events into it, and these
 * functions are the one place that says what each event looks like.
 *
 *   system:init   — opens a turn and names the provider's session id;
 *   assistant     — text, thinking or a tool use;
 *   user          — a tool result;
 *   result        — closes the turn (`is_error`, `subtype`, usage, cost);
 *   provider_retry — the provider retries a request itself, the turn goes on;
 *   assistant_delta — ephemeral partial text, never persisted.
 */

import {
  ASSISTANT_DELTA, PROVIDER_RETRY, type AssistantDeltaPayload, type NormalizedEvent, type ProviderRetryKind,
  type ProviderRetryPayload,
} from '../types.js';

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
};

/** Opens a turn. Exactly one per turn, and the only event
 *  `extractInitSessionId` reads. `backend` is the PROFILE's name, never the
 *  dialect's: a dialect shared by several profiles that wrote its own name would
 *  make the agent believe it is another model. */
export function systemInitEvent(init: {
  sessionId: string;
  backend?: string;
  model?: string;
  mcpServers?: unknown[];
  tools?: string[];
}): NormalizedEvent {
  return {
    type: 'system',
    payload: {
      type: 'system',
      subtype: 'init',
      session_id: init.sessionId,
      ...(init.backend !== undefined ? { backend: init.backend } : {}),
      ...(init.model !== undefined ? { model: init.model } : {}),
      mcp_servers: init.mcpServers ?? [],
      tools: init.tools ?? [],
    },
  };
}

function assistantEvent(id: string | undefined, block: Record<string, unknown>): NormalizedEvent {
  return {
    type: 'assistant',
    payload: {
      type: 'assistant',
      message: { ...(id !== undefined ? { id } : {}), role: 'assistant', content: [block] },
    },
  };
}

/** The assistant's answer (a whole block, not a partial: see `assistantDeltaEvent`). */
export function assistantTextEvent(text: string, id?: string): NormalizedEvent {
  return assistantEvent(id, { type: 'text', text });
}

/** The model's reasoning, shown folded in the chat. */
export function assistantThinkingEvent(thinking: string, id?: string): NormalizedEvent {
  return assistantEvent(id, { type: 'thinking', thinking });
}

/** A tool call. `id` pairs it with its `toolResultEvent` and keys its trace span. */
export function toolUseEvent(call: { id: string; name: string; input: unknown }): NormalizedEvent {
  return assistantEvent(call.id, { type: 'tool_use', id: call.id, name: call.name, input: call.input });
}

/** The outcome of a tool call, sent back to the model as a user message. */
export function toolResultEvent(result: { toolUseId: string; content: string; isError?: boolean }): NormalizedEvent {
  return {
    type: 'user',
    payload: {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: result.toolUseId,
          content: result.content,
          is_error: result.isError === true,
        }],
      },
    },
  };
}

/** Closes a turn that went well. The runner reads `usage` to tell a turn that
 *  worked from one that produced nothing. */
export function resultSuccessEvent(done: { usage?: TokenUsage; totalCostUsd?: number } = {}): NormalizedEvent {
  const usage = done.usage;
  return {
    type: 'result',
    payload: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: done.totalCostUsd ?? 0,
      ...(usage
        ? {
          usage: {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
          },
        }
        : {}),
    },
  };
}

/** Closes a turn that failed. `apiErrorStatus` is the HTTP status when the
 *  provider answered with one: the usage-limit detector reads 429 and 402 off it
 *  (see `rateLimitFromEvent`), so set it whenever you have it rather than
 *  leaving the text to be pattern-matched. */
export function resultErrorEvent(failure: { error: string; apiErrorStatus?: number; totalCostUsd?: number }): NormalizedEvent {
  return {
    type: 'result',
    payload: {
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: failure.error,
      total_cost_usd: failure.totalCostUsd ?? 0,
      ...(failure.apiErrorStatus !== undefined ? { api_error_status: failure.apiErrorStatus } : {}),
    },
  };
}

/** A fragment of the answer being written. `append` for increments (the
 *  default), `replace` when the CLI re-emits the whole text so far. */
export function assistantDeltaEvent(text: string, mode: AssistantDeltaPayload['mode'] = 'append'): NormalizedEvent {
  const payload: AssistantDeltaPayload = { text, mode };
  return { type: ASSISTANT_DELTA, payload };
}

/** The kind of a provider retry, read off its HTTP status first, its words
 *  second. A status is a fact; the words are a fallback for CLIs that drop it. */
export function providerRetryKind(cause: string, status?: number | null): ProviderRetryKind {
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (typeof status === 'number' && status >= 500 && status < 600) return 'server';
  if (/overloaded/i.test(cause)) return 'overloaded';
  if (/rate[ _-]?limit|too many requests|\b429\b/i.test(cause)) return 'rate_limit';
  if (/\b5\d\d\b|server[ _-]?error|internal error|bad gateway|service unavailable/i.test(cause)) return 'server';
  return 'transport';
}

/**
 * The provider is retrying a request on its own: the turn goes on. Emit it for
 * every attempt the CLI reports, and NEVER a `result` for one — a `result`
 * closes the turn, and the agent that asked would be told it failed while the
 * provider was still trying. `kind` defaults to what `providerRetryKind` reads
 * from the status and the cause.
 */
export function providerRetryEvent(retry: {
  attempt?: number | null;
  max?: number | null;
  cause: string;
  delayMs?: number | null;
  status?: number | null;
  kind?: ProviderRetryKind;
}): NormalizedEvent {
  const count = (n: number | null | undefined): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  const payload: ProviderRetryPayload = {
    type: PROVIDER_RETRY,
    attempt: count(retry.attempt),
    max: count(retry.max),
    cause: retry.cause,
    delay_ms: count(retry.delayMs),
    kind: retry.kind ?? providerRetryKind(retry.cause, retry.status),
  };
  return { type: PROVIDER_RETRY, payload };
}

/**
 * `Dialect.extractSessionId` for the vocabulary above: the session id carried by
 * a `system:init`, and nothing else. An empty id is no id, and no other event may
 * invent one.
 */
export function extractInitSessionId(ev: NormalizedEvent): string | null {
  if (ev.type !== 'system' || ev.payload === null || typeof ev.payload !== 'object') return null;
  const obj = ev.payload as { subtype?: string; session_id?: unknown };
  if (obj.subtype !== 'init') return null;
  return typeof obj.session_id === 'string' && obj.session_id.length > 0 ? obj.session_id : null;
}
