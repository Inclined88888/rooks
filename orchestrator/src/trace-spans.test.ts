/**
 * Phase W.0 — traceability schema and span store (docs/PRD-WORKFLOWS.md §3).
 * Own ROOKS_HOME: `db.ts` opens the database at module load, and the suites
 * run in parallel processes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-trace-spans-test-'));

const { db } = await import('./db.js');

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}
function indexes(table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name);
}

test('schema: trace_spans has the PRD §3.2 columns and indexes', () => {
  assert.deepEqual(columns('trace_spans'), [
    'id', 'trace_id', 'mission_id', 'parent_span_id', 'workflow_run_id', 'workflow_node_id',
    'seq', 'kind', 'name', 'status', 'started_at', 'ended_at', 'duration_ms',
    'input', 'output', 'error', 'tokens_in', 'tokens_out', 'cost_usd',
    'event_id_start', 'event_id_end',
  ]);
  for (const idx of ['idx_spans_trace', 'idx_spans_mission', 'idx_spans_run', 'idx_spans_open']) {
    assert.ok(indexes('trace_spans').includes(idx), `missing index ${idx}`);
  }
});

test('schema: trace_id / workflow columns added to missions, tasks, agent_messages', () => {
  const missions = columns('missions');
  for (const c of ['trace_id', 'workflow_run_id', 'workflow_node_id']) assert.ok(missions.includes(c), c);
  assert.ok(columns('tasks').includes('trace_id'));
  assert.ok(columns('agent_messages').includes('trace_id'));
});

const { dbApi } = await import('./db.js');
const { randomUUID } = await import('node:crypto');

test('upsertSpans: open then close, idempotent on both sides', () => {
  const mission = randomUUID();
  dbApi.createMission(mission, 'agent-a', 'span store witness');
  const t0 = 1_000_000;
  const open = {
    op: 'open' as const, id: 'toolu_1', trace_id: mission, mission_id: mission,
    seq: 1, kind: 'tool' as const, name: 'Read', started_at: t0, input: '{"file":"x"}',
  };
  assert.deepEqual(dbApi.upsertSpans([open]), { opened: 1, closed: 0 });
  // re-open of an existing id → no-op, the first version stays
  assert.deepEqual(dbApi.upsertSpans([{ ...open, name: 'Write' }]), { opened: 0, closed: 0 });
  let [row] = dbApi.listSpans(mission);
  assert.equal(row.name, 'Read');
  assert.equal(row.status, 'running');
  assert.equal(row.ended_at, null);

  assert.deepEqual(
    dbApi.upsertSpans([{ op: 'close', id: 'toolu_1', status: 'ok', ended_at: t0 + 250, output: '"done"' }]),
    { opened: 0, closed: 1 },
  );
  [row] = dbApi.listSpans(mission);
  assert.equal(row.status, 'ok');
  assert.equal(row.ended_at, t0 + 250);
  assert.equal(row.duration_ms, 250);
  assert.equal(row.output, '"done"');
  assert.equal(row.input, '{"file":"x"}', 'close keeps the input written at open');

  // re-close of a closed span → no-op, history is written once
  assert.deepEqual(
    dbApi.upsertSpans([{ op: 'close', id: 'toolu_1', status: 'error', error: 'late' }]),
    { opened: 0, closed: 0 },
  );
  [row] = dbApi.listSpans(mission);
  assert.equal(row.status, 'ok');
  assert.equal(row.error, null);
  // close of an unknown id → no-op too
  assert.deepEqual(dbApi.upsertSpans([{ op: 'close', id: 'nope', status: 'ok' }]), { opened: 0, closed: 0 });
  assert.deepEqual(dbApi.upsertSpans([]), { opened: 0, closed: 0 });
});

test('upsertSpans: instantaneous span carries its terminal status at open time', () => {
  const mission = randomUUID();
  dbApi.createMission(mission, 'agent-a', 'instant span witness');
  dbApi.upsertSpans([{
    op: 'open', id: randomUUID(), trace_id: mission, mission_id: mission, seq: 3,
    kind: 'switch', name: 'sonnet', started_at: 42, status: 'ok',
  }]);
  const [row] = dbApi.listSpans(mission);
  assert.equal(row.status, 'ok');
  assert.equal(row.ended_at, 42);
  assert.equal(row.duration_ms, 0);
});

test('listSpansByTrace / listSpansByRun / closeOpenSpans', () => {
  const trace = randomUUID();
  const run = randomUUID();
  const m1 = randomUUID();
  const m2 = randomUUID();
  dbApi.createMission(m1, 'agent-a', 'trace list witness 1');
  dbApi.createMission(m2, 'agent-b', 'trace list witness 2');
  dbApi.upsertSpans([
    { op: 'open', id: 's1', trace_id: trace, mission_id: m1, seq: 1, kind: 'turn', name: 'turn', started_at: 10,
      workflow_run_id: run, workflow_node_id: 'n1' },
    { op: 'open', id: 's2', trace_id: trace, mission_id: m1, seq: 2, kind: 'tool', name: 'Bash', started_at: 20,
      parent_span_id: 's1', workflow_run_id: run, workflow_node_id: 'n1' },
    { op: 'open', id: 's3', trace_id: trace, mission_id: m2, seq: 1, kind: 'turn', name: 'turn', started_at: 15 },
    { op: 'close', id: 's3', status: 'ok', ended_at: 16 },
  ]);
  assert.deepEqual(dbApi.listSpansByTrace(trace).map((s) => s.id), ['s1', 's3', 's2'], 'chronological');
  assert.deepEqual(dbApi.listSpansByRun(run).map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(dbApi.listSpans(m1).map((s) => s.id), ['s1', 's2']);

  assert.equal(dbApi.closeOpenSpans(m1, 'interrupted', 'reaped'), 2);
  assert.equal(dbApi.closeOpenSpans(m1, 'interrupted'), 0, 'nothing left running');
  for (const s of dbApi.listSpans(m1)) {
    assert.equal(s.status, 'interrupted');
    assert.equal(s.error, 'reaped');
    assert.ok(s.ended_at !== null && s.duration_ms !== null);
  }
  assert.equal(dbApi.listSpans(m2)[0].status, 'ok', 'other mission untouched');
});

test('creation: a mission is its own root, then adopts its ancestor trace', () => {
  const root = randomUUID();
  dbApi.createMission(root, 'agent-a', 'root');
  assert.equal(dbApi.getMission(root)?.trace_id, root, 'own id when nothing precedes');

  const child = randomUUID();
  dbApi.createMission(child, 'agent-b', 'child');
  dbApi.setMissionLineage(child, { parentMissionId: root, parentAgent: 'agent-a' });
  assert.equal(dbApi.getMission(child)?.trace_id, root, 'parent trace via setMissionLineage');

  const fork = randomUUID();
  dbApi.createMission(fork, 'agent-b', 'fork');
  dbApi.setForkedFrom(fork, child);
  assert.equal(dbApi.getMission(fork)?.trace_id, root, 'forked_from');

  const task = randomUUID();
  dbApi.createTask(task, 'task by child', 'agent-c', { creatorMissionId: child });
  assert.equal(dbApi.getTask(task)?.trace_id, root, 'task from its creator mission');
  const taskMission = randomUUID();
  dbApi.createMission(taskMission, 'agent-c', 'task mission');
  dbApi.setMissionLineage(taskMission, { taskId: task, parentAgent: 'agent-a' });
  assert.equal(dbApi.getMission(taskMission)?.trace_id, root, 'task_id alone is enough');

  const msg = dbApi.enqueueMessage({
    id: randomUUID(), fromMission: fork, fromAgent: 'agent-b', toAgent: 'agent-a', payload: 'x',
  });
  assert.equal(msg.trace_id, root);
  assert.equal(dbApi.getMessage(msg.id)?.trace_id, root, 'message from its sender mission');

  const orphanTask = randomUUID();
  dbApi.createTask(orphanTask, 'no creator', 'agent-c');
  assert.equal(dbApi.getTask(orphanTask)?.trace_id, null, 'no creator → no trace, backfill leaves it');
});

test('creation: an explicit trace wins over the lineage', () => {
  const run = randomUUID();
  const parent = randomUUID();
  dbApi.createMission(parent, 'agent-a', 'parent');
  const node = randomUUID();
  dbApi.createMission(node, 'agent-b', 'workflow node mission', undefined, null, run);
  dbApi.setMissionLineage(node, { parentMissionId: parent });
  assert.equal(dbApi.getMission(node)?.trace_id, run, 'lineage does not overwrite an imposed trace');
  const task = randomUUID();
  dbApi.createTask(task, 'explicit', 'agent-c', { creatorMissionId: parent, traceId: run });
  assert.equal(dbApi.getTask(task)?.trace_id, run);
});

test('#53: a run lists the tool spans of the missions its agent nodes launched', () => {
  const trace = randomUUID();
  const run = randomUUID();
  const agentMission = randomUUID();
  const stranger = randomUUID();
  dbApi.createMission(agentMission, 'agent-a', 'workflow node', undefined, null, null, { runId: run, nodeId: 'n2' });
  dbApi.createMission(stranger, 'agent-b', 'not in the run');
  // The engine writes its own spans under a system mission (engine.ts).
  const system = randomUUID();
  dbApi.createMission(system, 'system', 'engine');
  dbApi.upsertSpans([
    { op: 'open', id: 'node', trace_id: trace, mission_id: system, seq: 1, kind: 'node', name: 'agent', started_at: 5,
      workflow_run_id: run, workflow_node_id: 'n2' },
    // Written from the CLI stream: no run id travels with them.
    { op: 'open', id: 'turn', trace_id: trace, mission_id: agentMission, seq: 1, kind: 'turn', name: 'turn', started_at: 10 },
    { op: 'open', id: 'read', trace_id: trace, mission_id: agentMission, seq: 2, kind: 'tool', name: 'Read', started_at: 11,
      parent_span_id: 'turn' },
    { op: 'open', id: 'other', trace_id: trace, mission_id: stranger, seq: 1, kind: 'tool', name: 'Bash', started_at: 12 },
  ]);
  const spans = dbApi.listSpansByRun(run);
  assert.deepEqual(spans.map((s) => s.id), ['node', 'turn', 'read']);
  assert.ok(spans.every((s) => s.workflow_run_id === run && s.workflow_node_id === 'n2'), 'grouped under their node');
});

test('#435: a run reads its missions first, never every span without a run id', async () => {
  const { LIST_SPANS_BY_RUN_SQL } = await import('./db.js');
  assert.ok(indexes('missions').includes('idx_missions_workflow_run'));
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${LIST_SPANS_BY_RUN_SQL}`).all({ run: 'r' }) as { detail: string }[])
    .map((row) => row.detail);
  const shown = JSON.stringify(plan);
  // The `IS NULL` branch searched idx_spans_run for NULL: the whole table on a real home.
  assert.equal(plan.filter((detail) => detail.includes('idx_spans_run')).length, 1, shown);
  assert.ok(!plan.some((detail) => detail.includes('MULTI-INDEX OR')), shown);
  assert.ok(plan.some((detail) => /SEARCH m USING (COVERING )?INDEX idx_missions_workflow_run/.test(detail)), shown);
  assert.ok(plan.some((detail) => /SEARCH s USING INDEX idx_spans_mission/.test(detail)), shown);
});
