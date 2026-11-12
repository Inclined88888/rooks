/**
 * The vocabulary of trace spans, free of the daemon: a dialect emits `SpanOp`s
 * and the store applies them, so the SDK can hand the same types to a provider
 * without dragging the database along. Moved verbatim out of `db.ts`.
 */

/** What a span stands for — see docs/PRD-WORKFLOWS.md §4.1 for who opens and
 *  closes each kind. */
export const SPAN_KINDS = [
  'turn', 'tool', 'thinking', 'permission', 'spawn', 'message', 'switch',
  'interrupt', 'node', 'workflow',
] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];
export const SPAN_STATUSES = ['running', 'ok', 'error', 'denied', 'timeout', 'interrupted'] as const;
export type SpanStatus = (typeof SPAN_STATUSES)[number];

/** Open a span. Absent `status` = `running`; an instantaneous span (switch,
 *  interrupt) passes a terminal status and `ended_at` in the same op. Opening
 *  an id that already exists is a no-op. */
export type SpanOpenOp = {
  op: 'open';
  id: string;
  trace_id: string;
  mission_id: string;
  seq: number;
  kind: SpanKind;
  name: string;
  started_at: number;
  parent_span_id?: string | null;
  workflow_run_id?: string | null;
  workflow_node_id?: string | null;
  status?: SpanStatus;
  ended_at?: number | null;
  input?: string | null;
  output?: string | null;
  error?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  event_id_start?: number | null;
  event_id_end?: number | null;
};

/** Close a `running` span. Closing an unknown or already closed span is a
 *  no-op: a `tool_result` replayed on `--resume` must not rewrite history. */
export type SpanCloseOp = {
  op: 'close';
  id: string;
  status: Exclude<SpanStatus, 'running'>;
  ended_at?: number;
  output?: string | null;
  error?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  event_id_end?: number | null;
};

export type SpanOp = SpanOpenOp | SpanCloseOp;
