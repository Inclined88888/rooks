/**
 * Hermes run events → Timon's normalized vocabulary (`assistant`,
 * `assistant_delta`, `user`, `result`). One mapper per turn; pure, no I/O, never
 * throws on an unexpected payload.
 *
 * Measured on Hermes (10/10/2026), and where the Hermes Web UI is wrong:
 *  - `reasoning.available` carries the assistant's TEXT for the turn, not the
 *    model's reasoning (the Runs API emits no reasoning at all). It is never
 *    shown as thinking; it only stands in for the answer when nothing else
 *    carried it.
 *  - `tool.started` / `tool.completed` carry no call id: they pair in order,
 *    per tool name.
 *  - `run.completed.output` is the turn's final answer, and wins over what the
 *    deltas streamed (a reconnection may have missed some).
 */
import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@timon-ai/sdk';

export type HermesEvent = { readonly event: string; readonly [key: string]: unknown };

/** Tool name of a Hermes sub-agent card. Never `Task` / `Agent`: the chat
 *  paints those as forbidden native sub-agents. */
export const SUBAGENT_TOOL = 'hermes_subagent';

export type TurnEnd =
  | { readonly kind: 'completed'; readonly output: string | null; readonly usage: unknown }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'interrupted'; readonly message: string; readonly partial: string | null };

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The payload of a `data:` line, or null when it is not a Hermes event. */
export function parseEvent(data: string): HermesEvent | null {
  try {
    const value = record(JSON.parse(data));
    return value && typeof value.event === 'string' ? value as HermesEvent : null;
  } catch {
    return null;
  }
}

function assistant(content: unknown[]): NormalizedEvent {
  return { type: 'assistant', payload: { type: 'assistant', message: { id: randomUUID(), role: 'assistant', content } } };
}

function toolResult(id: string, text: string, isError: boolean): NormalizedEvent {
  return {
    type: 'user',
    payload: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } },
  };
}

/** Hermes' usage block in the shape the result line of every dialect uses. */
function usage(value: unknown): Record<string, number> | null {
  const u = record(value);
  if (!u) return null;
  const out: Record<string, number> = {};
  const pairs: Array<[string, string]> = [
    ['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
    ['cache_read_tokens', 'cache_read_input_tokens'], ['cache_write_tokens', 'cache_creation_input_tokens'],
  ];
  for (const [from, to] of pairs) {
    const n = num(u[from]);
    if (n !== null) out[to] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export class TurnMapper {
  /** Answer text streamed since the last assistant message was emitted. */
  private buffer = '';
  /** Last assistant text emitted, for the result line. */
  private lastText = '';
  /** `reasoning.available`: the answer once more, kept as a last resort. */
  private fallbackText = '';
  private readonly openTools = new Map<string, string[]>();
  private toolCount = 0;
  /** The tool name of the last call, for an approval card (the request has none). */
  lastTool: string | null = null;
  private ended = false;

  constructor(private readonly idPrefix: string) {}

  /** True once `finish` produced the result line. */
  get finished(): boolean {
    return this.ended;
  }

  map(ev: HermesEvent): NormalizedEvent[] {
    if (this.ended) return [];
    switch (ev.event) {
      case 'message.delta': {
        const delta = str(ev.delta);
        if (!delta) return [];
        this.buffer += delta;
        return [{ type: 'assistant_delta', payload: { text: delta, mode: 'append' } }];
      }
      case 'message.interim': {
        // A message the agent sent before going on ("let me check first").
        // Streamed already, it is what the buffer holds; otherwise it is new.
        const text = str(ev.text) ?? '';
        if (ev.already_streamed === true) return this.flush(text);
        return [...this.flush(), ...this.text(text)];
      }
      case 'reasoning.available': {
        this.fallbackText = str(ev.text) ?? this.fallbackText;
        return [];
      }
      case 'tool.started': {
        const tool = str(ev.tool) ?? 'tool';
        const id = `${this.idPrefix}-tool-${++this.toolCount}`;
        const queue = this.openTools.get(tool) ?? [];
        queue.push(id);
        this.openTools.set(tool, queue);
        this.lastTool = tool;
        const preview = str(ev.preview);
        return [...this.flush(), assistant([{ type: 'tool_use', id, name: tool, input: preview ? { preview } : {} }])];
      }
      case 'tool.completed': {
        const tool = str(ev.tool) ?? 'tool';
        const queue = this.openTools.get(tool);
        let id = queue?.shift();
        const out = this.flush();
        if (!id) {
          // A completion whose start this stream never carried (a resumed run):
          // shown anyway, a result is never an orphan.
          id = `${this.idPrefix}-tool-${++this.toolCount}`;
          out.push(assistant([{ type: 'tool_use', id, name: tool, input: {} }]));
        }
        out.push(toolResult(id, str(ev.preview) ?? '', ev.error === true));
        return out;
      }
      case 'subagent.start': {
        const id = str(ev.subagent_id) ?? `${this.idPrefix}-subagent-${++this.toolCount}`;
        const goal = str(ev.goal) ?? str(ev.preview) ?? '';
        const input: Record<string, unknown> = { description: goal };
        for (const key of ['preview', 'model', 'task_index', 'task_count', 'depth'] as const) {
          if (ev[key] !== undefined && ev[key] !== null) input[key] = ev[key];
        }
        return [...this.flush(), assistant([{ type: 'tool_use', id, name: SUBAGENT_TOOL, input, ...(goal ? { title: goal } : {}) }])];
      }
      case 'subagent.complete': {
        const id = str(ev.subagent_id);
        if (!id) return [];
        const status = str(ev.status) ?? 'completed';
        const summary = str(ev.summary) ?? status;
        return [...this.flush(), toolResult(id, summary, status !== 'completed')];
      }
      default:
        return [];
    }
  }

  /** The turn's last lines: the remaining answer, then the `result`. */
  finish(end: TurnEnd): NormalizedEvent[] {
    if (this.ended) return [];
    this.ended = true;
    const out: NormalizedEvent[] = [];
    if (end.kind === 'completed') {
      const final = (end.output ?? '') || this.buffer || (this.lastText ? '' : this.fallbackText);
      this.buffer = '';
      out.push(...this.text(final));
    } else if (end.kind === 'interrupted' && !this.buffer && !this.lastText && end.partial) {
      out.push(...this.text(end.partial));
    } else {
      out.push(...this.flush());
    }
    const failed = end.kind === 'failed' || end.kind === 'interrupted';
    const u = end.kind === 'completed' ? usage(end.usage) : null;
    out.push({
      type: 'result',
      payload: {
        type: 'result',
        subtype: failed ? 'error' : end.kind === 'cancelled' ? 'cancelled' : 'success',
        is_error: failed,
        ...(failed ? { error: end.message } : {}),
        ...(this.lastText ? { result: this.lastText } : {}),
        stop_reason: end.kind === 'completed' ? 'end_turn' : end.kind === 'cancelled' ? 'cancelled' : end.kind === 'interrupted' ? 'interrupted' : 'error',
        total_cost_usd: 0,
        ...(u ? { usage: u } : {}),
      },
    });
    return out;
  }

  /** The buffered answer as one persisted message. `replace` is what the agent
   *  said it streamed, when the buffer missed it (a resumed stream). */
  private flush(replace?: string): NormalizedEvent[] {
    const text = this.buffer || replace || '';
    this.buffer = '';
    return this.text(text);
  }

  private text(text: string): NormalizedEvent[] {
    if (!text.trim()) return [];
    this.lastText = text;
    return [assistant([{ type: 'text', text }])];
  }
}
