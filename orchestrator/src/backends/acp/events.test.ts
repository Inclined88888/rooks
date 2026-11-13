/**
 * `session/update` → normalized events and spans, replayed from fixtures
 * reconstituted from the opencode 1.18.33 and hermes-agent 0.21.0 probes
 * (2026-09-29). No agent is started.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-acp-events-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const {
  AcpEventMapper, acpInitEvent, acpUpdateKind, acpUpdateSessionId, extractAcpSessionId,
} = await import('./events.js');
const { acpSpans } = await import('./spans.js');
type NormalizedEvent = import('../types.js').NormalizedEvent;
type SpanOp = import('../types.js').SpanOp;
type SpanState = import('../types.js').SpanState;
type AcpUsage = import('./transport.js').AcpUsage;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

type Rec = Record<string, unknown>;
type Line = { method?: string; params?: Rec; result?: Rec };

function fixture(name: string): Line[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Line);
}

/** Drive a mapper the way the driver does: updates as they come, then the
 *  reply of `session/prompt` closes the turn. */
function replay(name: string, mapper = new AcpEventMapper()): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  mapper.beginTurn();
  for (const line of fixture(name)) {
    if (line.method === 'session/update') out.push(...mapper.update(line.params as Rec));
    else if (line.result) {
      out.push(...mapper.finishTurn({
        stopReason: line.result.stopReason as string,
        usage: (line.result.usage ?? null) as AcpUsage | null,
      }));
    }
  }
  return out;
}

const upd = (update: Rec, sessionId = 's1'): Rec => ({ sessionId, update });

function blocks(ev: NormalizedEvent): Rec[] {
  const m = (ev.payload as { message?: { content?: unknown } }).message;
  return Array.isArray(m?.content) ? (m.content as Rec[]) : [];
}

/** Shape of an event for a sequence assertion: `type` plus its block types. */
function shape(ev: NormalizedEvent): string {
  if (ev.type === 'assistant') return `assistant:${blocks(ev).map((b) => `${b.type}${b.name ? `(${b.name})` : ''}`).join('+')}`;
  if (ev.type === 'user') return `user:${blocks(ev).map((b) => `${b.type}${b.is_error ? '!' : ''}`).join('+')}`;
  return ev.type;
}

function freshState(): SpanState {
  return { missionId: 'm-1', traceId: 't-1', turn: null, tools: new Map(), maxBytes: 4096 };
}

function spansOf(events: NormalizedEvent[]): SpanOp[] {
  const state = freshState();
  const ops: SpanOp[] = [];
  let id = 100;
  for (const ev of events) ops.push(...acpSpans(ev, state, id++));
  return ops;
}

type OpenOp = Extract<SpanOp, { op: 'open' }>;
type CloseOp = Extract<SpanOp, { op: 'close' }>;
const opens = (ops: SpanOp[]): OpenOp[] => ops.filter((o): o is OpenOp => o.op === 'open');
const closes = (ops: SpanOp[]): CloseOp[] => ops.filter((o): o is CloseOp => o.op === 'close');

/* ── opencode ───────────────────────────────────────────────────────────── */

test('opencode turn: deltas, folded text, tools with their input, one result', () => {
  const events = replay('opencode-turn.jsonl');
  assert.deepEqual(events.map(shape), [
    'assistant_delta', 'assistant_delta',
    // text flushed when the first tool appears, tool held until it has input
    'assistant:text', 'assistant:tool_use(Bash)', 'user:tool_result',
    'assistant:tool_use(read)', 'user:tool_result!',
    'assistant_delta', 'assistant_delta',
    'assistant:text',
    'result',
  ]);

  assert.deepEqual(events[0]!.payload, { text: 'I will list ', mode: 'append' });
  assert.equal(blocks(events[2]!)[0]!.text, 'I will list the files.');

  const bash = blocks(events[3]!)[0]!;
  assert.equal(bash.id, 'call_1');
  assert.deepEqual(bash.input, { command: 'ls', description: 'List files' });
  assert.equal(bash.title, 'List files');
  assert.equal(bash.acp_kind, 'execute');
  const bashResult = blocks(events[4]!)[0]!;
  assert.equal(bashResult.tool_use_id, 'call_1');
  assert.equal(bashResult.content, 'a.txt\nb.txt\n');
  assert.equal(bashResult.is_error, false);

  const failed = blocks(events[6]!)[0]!;
  assert.equal(failed.tool_use_id, 'call_2');
  assert.equal(failed.content, 'File not found: /tmp/missing.txt');
  assert.equal(failed.is_error, true);
});

test('opencode result: tokens from the prompt reply, USD cost from the cumulative usage_update', () => {
  const result = replay('opencode-turn.jsonl').at(-1)!;
  assert.equal(result.type, 'result');
  assert.deepEqual(result.payload, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Two files: a.txt, b.txt. missing.txt does not exist.',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0034,
    usage: { input_tokens: 1500, output_tokens: 210, cache_read_input_tokens: 900, reasoning_tokens: 0 },
    context_tokens: 1800,
    context_window: 200000,
  });
});

test('cost is per turn: the second turn is charged the difference', () => {
  const mapper = new AcpEventMapper();
  replay('opencode-turn.jsonl', mapper);
  mapper.beginTurn();
  mapper.update(upd({ sessionUpdate: 'usage_update', used: 2000, size: 200000, cost: { amount: 0.005, currency: 'USD' } }));
  const [result] = mapper.finishTurn({ stopReason: 'end_turn' });
  const cost = (result!.payload as { total_cost_usd: number }).total_cost_usd;
  assert.ok(Math.abs(cost - (0.005 - 0.0034)) < 1e-9, `got ${cost}`);
});

test('a cost in another currency is not read as dollars', () => {
  const mapper = new AcpEventMapper();
  mapper.beginTurn();
  mapper.update(upd({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 9, currency: 'EUR' } }));
  const [result] = mapper.finishTurn({ stopReason: 'end_turn' });
  assert.equal((result!.payload as { total_cost_usd: number }).total_cost_usd, 0);
});

test('opencode spans: turn, tool spans keyed by toolCallId, closed with their outcome', () => {
  const ops = spansOf(replay('opencode-turn.jsonl'));
  const o = opens(ops);
  assert.deepEqual(o.map((s) => [s.kind, s.name]), [['turn', 'turn'], ['tool', 'Bash'], ['tool', 'read']]);
  assert.deepEqual(o.slice(1).map((s) => s.id), ['call_1', 'call_2']);
  assert.match(o[1]!.input ?? '', /"command":"ls"/);
  assert.equal(o[1]!.parent_span_id, o[0]!.id);

  const c = closes(ops);
  assert.deepEqual(c.map((s) => [s.id, s.status]), [['call_1', 'ok'], ['call_2', 'error'], [o[0]!.id, 'ok']]);
  const turn = c.at(-1)!;
  assert.equal(turn.tokens_in, 1500);
  assert.equal(turn.tokens_out, 210);
  assert.equal(turn.cost_usd, 0.0034);
});

/* ── hermes ─────────────────────────────────────────────────────────────── */

test('hermes turn: 165 thought chunks become ONE thinking block, in the UI contract shape', () => {
  const events = replay('hermes-turn.jsonl');
  const thinking = events.filter((e) => e.type === 'assistant' && blocks(e).some((b) => b.type === 'thinking'));
  // 165 chunks up front, then 6 more after the tool: two runs, two blocks.
  assert.equal(thinking.length, 2);
  const first = blocks(thinking[0]!);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.type, 'thinking');
  assert.equal(typeof first[0]!.thinking, 'string');
  assert.equal((first[0]!.thinking as string).split(' ').filter(Boolean).length, 165);
  assert.equal(blocks(thinking[1]!)[0]!.thinking, 'ok ok ok ok ok ok ');
  // Nothing thought-shaped ever travels as its own event per chunk.
  assert.ok(events.length < 20, `${events.length} events`);
});

test('hermes turn: full sequence, plan as a todo list, tool content as result text', () => {
  const events = replay('hermes-turn.jsonl');
  assert.deepEqual(events.map(shape), [
    'assistant:thinking',
    'assistant:tool_use(TodoWrite)', 'user:tool_result',
    'assistant:tool_use(Bash)', 'user:tool_result',
    'assistant:tool_use(TodoWrite)', 'user:tool_result',
    'assistant:thinking',
    'assistant_delta', 'assistant_delta',
    'assistant:text',
    'result',
  ]);
  const plan = blocks(events[1]!)[0]!;
  assert.deepEqual(plan.input, {
    todos: [
      { content: 'List the files', status: 'in_progress', activeForm: 'List the files' },
      { content: 'Summarize', status: 'pending', activeForm: 'Summarize' },
    ],
  });
  const bash = blocks(events[3]!)[0]!;
  assert.equal(bash.id, 'tc-77');
  assert.equal(bash.name, 'Bash');
  assert.deepEqual(bash.input, { command: 'ls -la' });
  assert.equal(blocks(events[4]!)[0]!.content, 'total 8\ndrwxr-xr-x 2 u u 4096 .\n');

  const result = events.at(-1)!.payload as Rec;
  assert.equal(result.result, 'The directory is empty.');
  assert.deepEqual(result.usage, { input_tokens: 4200, output_tokens: 95, cache_read_input_tokens: 0, reasoning_tokens: 640 });
  assert.equal(result.total_cost_usd, 0);
});

test('hermes spans: the thinking block is a span, the plan and the tool are instantaneous/closed', () => {
  const ops = spansOf(replay('hermes-turn.jsonl'));
  const o = opens(ops);
  assert.deepEqual(o.map((s) => s.kind), ['turn', 'thinking', 'tool', 'tool', 'tool', 'thinking']);
  assert.deepEqual(o.filter((s) => s.kind === 'tool').map((s) => s.name), ['TodoWrite', 'Bash', 'TodoWrite']);
  assert.equal(closes(ops).at(-1)!.status, 'ok');
  assert.equal(closes(ops).at(-1)!.tokens_in, 4200);
});

test('a plan re-sent unchanged is not re-emitted', () => {
  const mapper = new AcpEventMapper();
  const plan = upd({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'low', status: 'pending' }] });
  assert.equal(mapper.update(plan).length, 2);
  assert.deepEqual(mapper.update(plan), []);
});

test('history replayed on session/resume is recognisable and user chunks are never events', () => {
  const lines = fixture('hermes-resume-replay.jsonl');
  const kinds = lines.map((l) => acpUpdateKind(l.params));
  assert.deepEqual(kinds, ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', 'session_info_update']);
  const mapper = new AcpEventMapper();
  assert.deepEqual(mapper.update(lines[0]!.params as Rec), []);
  assert.deepEqual(mapper.update(lines[3]!.params as Rec), []);
});

/* ── tools, in detail ───────────────────────────────────────────────────── */

test('a call is held while it has no input, and opened at the latest by the end of the turn', () => {
  const mapper = new AcpEventMapper();
  assert.deepEqual(mapper.update(upd({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'grep', kind: 'search', status: 'pending', rawInput: {} })), []);
  const end = mapper.finishTurn({ stopReason: 'end_turn' });
  assert.deepEqual(end.map(shape), ['assistant:tool_use(grep)', 'result']);
  assert.deepEqual(blocks(end[0]!)[0]!.input, {});
  // Never resolved: the span layer closes it as interrupted.
  const ops = spansOf(end);
  assert.deepEqual(closes(ops).map((c) => c.status), ['interrupted', 'ok']);
});

test('an update for a call never opened stands on its own, and a result is never orphaned', () => {
  const mapper = new AcpEventMapper();
  const ev = mapper.update(upd({ sessionUpdate: 'tool_call_update', toolCallId: 'late', title: 'Edit file', kind: 'edit', status: 'completed', rawOutput: 'done' }));
  assert.deepEqual(ev.map(shape), ['assistant:tool_use(Edit file)', 'user:tool_result']);
  // A second terminal update does not close it twice.
  assert.deepEqual(mapper.update(upd({ sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'completed' })), []);
});

test('the reasoning that precedes a tool is flushed before it, the text that follows stays after', () => {
  const mapper = new AcpEventMapper();
  const out: NormalizedEvent[] = [];
  out.push(...mapper.update(upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } })));
  out.push(...mapper.update(upd({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 't', kind: 'other', status: 'in_progress', rawInput: { q: 1 } })));
  out.push(...mapper.update(upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })));
  out.push(...mapper.finishTurn({ stopReason: 'end_turn' }));
  assert.deepEqual(out.map(shape), ['assistant:thinking', 'assistant:tool_use(t)', 'assistant_delta', 'assistant:text', 'result']);
});

/* ── terminal result ────────────────────────────────────────────────────── */

test('no reply from the agent: a success is synthesized, once', () => {
  const mapper = new AcpEventMapper();
  mapper.beginTurn();
  mapper.update(upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }));
  const end = mapper.finishTurn();
  assert.deepEqual(end.map(shape), ['assistant:text', 'result']);
  const p = end[1]!.payload as Rec;
  assert.equal(p.subtype, 'success');
  assert.equal(p.is_error, false);
  assert.equal(p.usage, undefined);
  assert.deepEqual(mapper.finishTurn({ stopReason: 'end_turn' }), []);
});

test('stop reasons: cancelled is not an error, a refusal or a cut-off is, a transport failure wins', () => {
  const stop = (o: Parameters<InstanceType<typeof AcpEventMapper>['finishTurn']>[0]): Rec => {
    const m = new AcpEventMapper();
    return m.finishTurn(o).at(-1)!.payload as Rec;
  };
  assert.deepEqual([stop({ stopReason: 'cancelled' }).subtype, stop({ stopReason: 'cancelled' }).is_error], ['cancelled', false]);
  const refusal = stop({ stopReason: 'refusal' });
  assert.deepEqual([refusal.subtype, refusal.is_error, refusal.error], ['error', true, 'agent stopped: refusal']);
  assert.equal(stop({ stopReason: 'max_tokens' }).is_error, true);
  const died = stop({ stopReason: 'end_turn', error: 'agent exited (code 3)' });
  assert.deepEqual([died.is_error, died.error], [true, 'agent exited (code 3)']);
});

test('the next turn starts clean', () => {
  const mapper = new AcpEventMapper();
  replay('hermes-turn.jsonl', mapper);
  mapper.beginTurn();
  const end = mapper.finishTurn({ stopReason: 'end_turn' });
  assert.deepEqual(end.map(shape), ['result']);
  assert.equal((end[0]!.payload as Rec).result, undefined);
});

/* ── robustness, session id ─────────────────────────────────────────────── */

test('anything unexpected yields [] and never throws', () => {
  const mapper = new AcpEventMapper();
  const junk: unknown[] = [
    null, undefined, 42, 'x', [], {}, { update: null }, { update: 'x' }, { update: {} },
    upd({ sessionUpdate: 12 }), upd({ sessionUpdate: 'agent_message_chunk' }),
    upd({ sessionUpdate: 'agent_message_chunk', content: null }),
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA' } }),
    upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 5 } }),
    upd({ sessionUpdate: 'tool_call' }), upd({ sessionUpdate: 'tool_call', toolCallId: 7 }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: {} }),
    upd({ sessionUpdate: 'plan' }), upd({ sessionUpdate: 'plan', entries: 'x' }),
    upd({ sessionUpdate: 'plan', entries: [null, 3, { content: 9 }] }),
    upd({ sessionUpdate: 'usage_update', used: 'a', cost: 'free' }),
    upd({ sessionUpdate: 'from_the_future', anything: true }),
  ];
  for (const j of junk) assert.deepEqual(mapper.update(j as Rec), []);
  // Circular data must not escape either.
  const loop: Rec = {};
  loop.self = loop;
  assert.doesNotThrow(() => mapper.update(upd({ sessionUpdate: 'tool_call', toolCallId: 'c', rawInput: loop, status: 'in_progress' })));
  assert.doesNotThrow(() => mapper.finishTurn({ stopReason: 'end_turn' }));
});

test('ignored updates make no noise', () => {
  const mapper = new AcpEventMapper();
  for (const kind of ['available_commands_update', 'config_option_update', 'session_info_update', 'current_mode_update', 'user_message_chunk']) {
    assert.deepEqual(mapper.update(upd({ sessionUpdate: kind, content: { type: 'text', text: 'x' } })), []);
  }
});

test('updates of another session are dropped when the mapper is bound to one', () => {
  const mapper = new AcpEventMapper({ sessionId: 's1' });
  const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } };
  assert.equal(mapper.update(upd(chunk, 's2')).length, 0);
  assert.equal(mapper.update(upd(chunk, 's1')).length, 1);
});

test('session id: read off the update, carried by system:init, read back by extractAcpSessionId', () => {
  assert.equal(acpUpdateSessionId(fixture('opencode-turn.jsonl')[0]!.params), 'ses_oc_01');
  assert.equal(acpUpdateSessionId({ sessionId: '' }), null);
  assert.equal(acpUpdateSessionId(null), null);
  const init = acpInitEvent('ses_oc_01', 'opencode');
  assert.equal((init.payload as Rec).backend, 'opencode');
  assert.equal(extractAcpSessionId(init), 'ses_oc_01');
  assert.equal(extractAcpSessionId({ type: 'result', payload: { session_id: 'x' } }), null);
  assert.equal(extractAcpSessionId({ type: 'system', payload: { subtype: 'other', session_id: 'x' } }), null);
  assert.equal(extractAcpSessionId({ type: 'system', payload: null }), null);
});

test('a thought that would never end is bounded', () => {
  const mapper = new AcpEventMapper();
  const big = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 8; i++) mapper.update(upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: big } }));
  const end = mapper.finishTurn({ stopReason: 'end_turn' });
  const text = blocks(end[0]!)[0]!.thinking as string;
  assert.ok(text.length < 300 * 1024);
  assert.match(text, /reasoning truncated/);
});
