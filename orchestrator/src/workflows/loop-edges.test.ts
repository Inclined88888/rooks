import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-workflow-loops-test-'));
const { db, dbApi } = await import('../db.js');
const { advance, createRun } = await import('./engine.js');
const { MAX_LOOP_ITERATIONS, parseWorkflowDefinition } = await import('./schema.js');

type Edge = { id: string; from: string; fromPort: string; to: string; toPort: string; condition?: string; loop?: boolean; maxIterations?: number };
const edge = (id: string, from: string, fromPort: string, to: string, extra: Partial<Edge> = {}): Edge => ({ id, from, fromPort, to, toPort: 'in', ...extra });

function seed(nodes: unknown[], edges: Edge[]) {
  const definition = parseWorkflowDefinition({ schemaVersion: 1, nodes, edges, variables: [], settings: { maxParallel: 3, onError: 'fail' } });
  const id = randomUUID(); const now = Date.now();
  dbApi.insertWorkflow({ id, slug: `loop-${id.slice(0, 8)}`, name: 'Loop witness', description: null, project: null, owner_user_id: null, draft: JSON.stringify(definition), published_version: 1, enabled: 1, created_at: now, updated_at: now, agent_name: null });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  return id;
}

async function settle(runId: string) {
  for (let i = 0; i < 200 && ['running', 'waiting'].includes(dbApi.getWorkflowRun(runId)?.status ?? ''); i++) {
    await advance(runId); await new Promise((resolve) => setImmediate(resolve));
  }
  return dbApi.getWorkflowRun(runId)!;
}
const attempts = (runId: string, nodeId: string) => dbApi.listWorkflowRunNodes(runId).filter((row) => row.node_id === nodeId);
const latest = (runId: string, nodeId: string) => attempts(runId, nodeId).at(-1)!;

// work (a pass-through) → check; check.false loops back to work, check.true leaves.
const loopNodes = (expr: string) => [
  { id: 'start', type: 'trigger.manual', config: {} },
  { id: 'work', type: 'join', config: { mode: 'all' } },
  { id: 'check', type: 'condition', config: { expr } },
  { id: 'result', type: 'output', config: { template: 'passes={{loops.again.count}}' } },
];
const loopEdges = (maxIterations: number, extra: Edge[] = []) => [
  edge('in', 'start', 'out', 'work'), edge('w', 'work', 'out', 'check'),
  edge('exit', 'check', 'true', 'result'),
  edge('again', 'check', 'false', 'work', { loop: true, maxIterations }),
  ...extra,
];

test('a loop edge runs its body again until the exit branch is taken', async () => {
  const run = createRun(seed(loopNodes('loops.again.count >= 2'), loopEdges(5)), { trigger: { kind: 'manual' } });
  const saved = await settle(run.id);
  assert.equal(saved.status, 'completed');
  assert.equal(attempts(run.id, 'work').length, 3, 'first pass plus two loop passes');
  assert.equal(attempts(run.id, 'check').length, 3);
  assert.deepEqual(attempts(run.id, 'check').map((row) => row.taken_port), ['false', 'false', 'true']);
  assert.equal(latest(run.id, 'result').status, 'ok');
  assert.equal(attempts(run.id, 'start').length, 1, 'a node upstream of the target never runs again');
  const context = JSON.parse(saved.context) as { output: string; loops: Record<string, { count: number; exhausted?: boolean }> };
  assert.equal(context.output, 'passes=2');
  assert.equal(context.loops.again?.count, 2);
  assert.notEqual(context.loops.again?.exhausted, true);
});

test('maxIterations bounds the loop: past it the edge is exhausted and the run still ends', async () => {
  const nodes = [...loopNodes('input.never == true'), { id: 'escalate', type: 'output', config: { template: 'gave up after {{loops.again.count}}' } }];
  // A sibling edge on the same port that only opens once the loop has given up.
  const run = createRun(seed(nodes, loopEdges(2, [edge('give-up', 'check', 'false', 'escalate', { condition: 'loops.again.exhausted == true' })])), { trigger: { kind: 'manual' } });
  const saved = await settle(run.id);
  assert.equal(saved.status, 'completed');
  assert.equal(attempts(run.id, 'work').length, 3, 'the loop edge is followed exactly maxIterations times');
  assert.equal(latest(run.id, 'result').status, 'skipped', 'the exit branch was never taken');
  assert.equal(latest(run.id, 'escalate').status, 'ok');
  assert.equal(attempts(run.id, 'escalate').filter((row) => row.status === 'ok').length, 1, 'the give-up branch runs once, at the end');
  const context = JSON.parse(saved.context) as { output: string; loops: Record<string, { count: number; exhausted?: boolean }> };
  assert.equal(context.output, 'gave up after 2');
  assert.equal(context.loops.again?.exhausted, true);
});

test('a version stored above the ceiling is refused at run, not looped a thousand times', () => {
  // Written past the publish schema, as a hand-edited row would be: every run re-validates its version.
  const definition = { schemaVersion: 1, nodes: loopNodes('input.never == true'), edges: loopEdges(MAX_LOOP_ITERATIONS * 10), variables: [], settings: { maxParallel: 3, onError: 'fail' } };
  const id = randomUUID(); const now = Date.now();
  dbApi.insertWorkflow({ id, slug: `loop-${id.slice(0, 8)}`, name: 'Loop witness', description: null, project: null, owner_user_id: null, draft: JSON.stringify(definition), published_version: 1, enabled: 1, created_at: now, updated_at: now, agent_name: null });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  assert.throws(() => createRun(id, { trigger: { kind: 'manual' } }), /must not exceed/);
  assert.equal(dbApi.listWorkflowRuns(id).length, 0);
});

test('a loop edge whose condition is false is not followed', async () => {
  const edges = loopEdges(5).map((item) => item.id === 'again' ? { ...item, condition: 'input.retry == true' } : item);
  const run = createRun(seed(loopNodes('input.never == true'), edges), { trigger: { kind: 'manual' }, input: { retry: false } });
  const saved = await settle(run.id);
  assert.equal(saved.status, 'completed');
  assert.equal(attempts(run.id, 'work').length, 1);
});

test('the next pass reads the output its previous pass produced', async () => {
  const nodes = [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'a', type: 'notify', config: { title: 'pass' } },
    // Its own output of the previous pass: the feedback a revision loop runs on.
    { id: 'b', type: 'notify', config: { title: 'prev={{nodes.b.output.notification_id}}' } },
    { id: 'check', type: 'condition', config: { expr: 'loops.again.count >= 1' } },
    { id: 'result', type: 'output', config: { template: 'done' } },
  ];
  const edges = [edge('in', 'start', 'out', 'a'), edge('ab', 'a', 'out', 'b'), edge('bc', 'b', 'out', 'check'), edge('exit', 'check', 'true', 'result'), edge('again', 'check', 'false', 'a', { loop: true, maxIterations: 3 })];
  const run = createRun(seed(nodes, edges), { trigger: { kind: 'manual' } });
  assert.equal((await settle(run.id)).status, 'completed');
  const [first, second] = attempts(run.id, 'b').map((row) => (JSON.parse(row.output!) as { notification_id: string }).notification_id);
  const title = (id: string) => (db.prepare('SELECT title FROM notifications WHERE id=?').get(id) as { title: string }).title;
  assert.equal(title(first!), 'prev=');
  assert.equal(title(second!), `prev=${first}`);
});

test('a loop nested in another starts each outer pass with its full budget', async () => {
  const nodes = [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'outer', type: 'join', config: { mode: 'all' } },
    { id: 'inner', type: 'join', config: { mode: 'all' } },
    { id: 'innerCheck', type: 'condition', config: { expr: 'input.never == true' } },
    { id: 'outerCheck', type: 'condition', config: { expr: 'input.never == true' } },
  ];
  const edges = [
    edge('in', 'start', 'out', 'outer'), edge('oi', 'outer', 'out', 'inner'), edge('ic', 'inner', 'out', 'innerCheck'),
    edge('innerLoop', 'innerCheck', 'false', 'inner', { loop: true, maxIterations: 2 }),
    edge('io', 'innerCheck', 'false', 'outerCheck', { condition: 'loops.innerLoop.exhausted == true' }),
    edge('outerLoop', 'outerCheck', 'false', 'outer', { loop: true, maxIterations: 1 }),
  ];
  const run = createRun(seed(nodes, edges), { trigger: { kind: 'manual' } });
  assert.equal((await settle(run.id)).status, 'completed');
  assert.equal(attempts(run.id, 'outer').length, 2);
  assert.equal(attempts(run.id, 'inner').filter((row) => row.status === 'ok').length, 6, '3 inner passes in each of the 2 outer passes');
});

test('publish refuses a loop edge without bound, above the ceiling, or closing no cycle', () => {
  const nodes = loopNodes('true');
  const refused = (edges: Edge[], message: RegExp) => assert.throws(() => parseWorkflowDefinition({ schemaVersion: 1, nodes, edges, variables: [], settings: {} }), message);
  const base = loopEdges(3);
  refused(base.map((item) => item.id === 'again' ? { ...item, maxIterations: undefined } : item), /loop edge requires maxIterations/);
  refused(base.map((item) => item.id === 'again' ? { ...item, maxIterations: MAX_LOOP_ITERATIONS + 1 } : item), /must not exceed/);
  // `loop` on a forward edge: there is no body leading back to its source.
  refused([...base.filter((item) => item.id !== 'exit'), edge('exit', 'check', 'true', 'result', { loop: true, maxIterations: 2 })], /must lead back/);
  // A cycle without the flag is still refused, and the bounded loop is admitted.
  refused(base.map((item) => item.id === 'again' ? { ...item, loop: undefined, maxIterations: undefined } : item), /cycle without loop edge/);
  assert.equal(parseWorkflowDefinition({ schemaVersion: 1, nodes, edges: base, variables: [], settings: {} }).edges.length, 4);
  // A node looping onto itself is the smallest cycle.
  assert.doesNotThrow(() => parseWorkflowDefinition({ schemaVersion: 1, nodes, edges: [...base.filter((item) => item.id !== 'again'), edge('self', 'check', 'false', 'check', { loop: true, maxIterations: 2 })], variables: [], settings: {} }));
});
