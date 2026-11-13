/**
 * Phase W.1 — spans written as the stream flows (docs/PRD-WORKFLOWS.md §4.2)
 * and the invariant §12.1: a failing span write changes nothing for the
 * mission.
 *
 * `node --test --import tsx src/trace-recorder.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { dbApi } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { getBackend } = await import('./backends/index.js');
const { loadSpanState, newSpanState, recordSpans } = await import('./trace-recorder.js');

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'backends', '__fixtures__', 'claude-tools.jsonl');
const claude = getBackend('claude');

/** What `processEvent` does with a line, minus the bus and the log. */
function feed(missionId: string, state: import('./backends/types.js').SpanState, line: string): number {
  let changed = 0;
  for (const ev of claude.parseLine(line)) {
    if (ev.type === 'assistant_delta') continue;
    const row = dbApi.insertEvent(missionId, ev.type, ev.payload);
    changed += recordSpans(claude, state, ev, row.id);
  }
  return changed;
}

/** The fixture, with tool_use_ids made unique to the caller: they are the
 *  PRIMARY KEY of `trace_spans` (one id, one span, whatever the mission) and
 *  the suites share one database. */
function fixtureLines(tag: string): string[] {
  return readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => l.replaceAll('toolu_0', `toolu_${tag}_0`));
}

test('a replayed claude turn lands in trace_spans with the mission trace_id and durations', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'trace witness', undefined, null, 'trace-root');
  const lines = fixtureLines('replay');
  const state = loadSpanState(missionId);
  assert.equal(state.traceId, 'trace-root');
  for (const line of lines) feed(missionId, state, line);

  const spans = dbApi.listSpans(missionId);
  assert.deepEqual(
    spans.map((s) => [s.kind, s.name, s.status]).sort(),
    [['thinking', 'thinking', 'ok'], ['tool', 'Bash', 'ok'], ['tool', 'Read', 'ok'], ['turn', 'turn', 'ok']].sort(),
  );
  for (const s of spans) {
    assert.equal(s.trace_id, 'trace-root');
    assert.equal(typeof s.duration_ms, 'number', `${s.name} has a duration`);
    assert.ok(s.duration_ms! >= 0);
  }
  const turn = spans.find((s) => s.kind === 'turn')!;
  assert.equal(turn.tokens_in, 5310);
  assert.equal(turn.tokens_out, 118);
  // seq / event ids bridge to the raw events of THIS mission
  const eventIds = dbApi.listEvents(missionId).map((e) => e.id);
  assert.ok(eventIds.includes(turn.event_id_start!));
  assert.ok(eventIds.includes(turn.event_id_end!));
  assert.equal(state.turn, null);
});

test('§12.1 — a throwing upsertSpans leaves events and the mission untouched', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'span failure witness');
  const original = dbApi.upsertSpans;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: unknown) => { warnings.push(String(msg)); };
  dbApi.upsertSpans = () => { throw new Error('disk full'); };
  const lines = fixtureLines('fail');
  try {
    const state = loadSpanState(missionId);
    let changed = 0;
    for (const line of lines) changed += feed(missionId, state, line);
    assert.equal(changed, 0, 'nothing recorded');
  } finally {
    dbApi.upsertSpans = original;
    console.warn = warn;
  }
  // every line was persisted as an event, exactly as without tracing
  assert.equal(dbApi.listEvents(missionId).length, lines.length);
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  assert.equal(dbApi.listSpans(missionId).length, 0);
  assert.ok(warnings.some((w) => w.includes('span write failed') && w.includes('disk full')));
});

test('a backend without spans() records nothing and costs nothing', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'untraced backend');
  const state = newSpanState(missionId, missionId);
  const n = recordSpans({ name: 'mute' }, state, { type: 'assistant', payload: { message: { content: [] } } }, 1);
  assert.equal(n, 0);
  assert.equal(dbApi.listSpans(missionId).length, 0);
});

test('loadSpanState rebuilds the open turn and tools from running spans (resume)', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'resume witness');
  const lines = fixtureLines('resume');
  const state = loadSpanState(missionId);
  // first process: opens a turn and a tool, then dies before the result
  feed(missionId, state, lines[1]);
  assert.ok(state.turn);
  assert.equal(state.tools.size, 2);

  // second process, fresh in-memory state
  const resumed = loadSpanState(missionId);
  assert.equal(resumed.turn?.id, state.turn.id);
  assert.deepEqual([...resumed.tools.keys()].sort(), ['toolu_resume_01ReadA', 'toolu_resume_02Bash']);

  // the replayed results close the spans of the FIRST process, no new turn
  for (const line of lines.slice(2)) feed(missionId, resumed, line);
  const spans = dbApi.listSpans(missionId);
  assert.equal(spans.filter((s) => s.kind === 'turn').length, 1);
  assert.equal(spans.filter((s) => s.status === 'running').length, 0);
});

test('loadSpanState on an unknown mission roots the trace at the mission id', () => {
  const id = randomUUID();
  const state = loadSpanState(id);
  assert.equal(state.traceId, id);
  assert.equal(state.turn, null);
  assert.ok(state.maxBytes >= 64);
});

test('§12.3 — mission completion closes every running span', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'terminal span witness');
  const state = loadSpanState(missionId);
  feed(missionId, state, fixtureLines('terminal').at(1)!);
  const openIds = dbApi.listSpans(missionId)
    .filter((span) => span.status === 'running')
    .map((span) => span.id);
  assert.ok(openIds.length > 0);

  dbApi.finishMission(missionId, 'terminated', 0, 'stopped');

  const spans = dbApi.listSpans(missionId);
  assert.ok(spans.length > 0);
  const closed = spans.filter((span) => openIds.includes(span.id));
  assert.ok(closed.every((span) => span.status === 'interrupted'));
  assert.ok(closed.every((span) => span.ended_at !== null && span.duration_ms !== null));
});
