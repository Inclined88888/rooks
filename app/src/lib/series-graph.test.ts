/**
 * The series graph is only useful if its topology is right: a wrong rank puts
 * two tasks in the same wave that are in fact sequential, and the reader draws
 * the opposite conclusion from the truth. The hostile inputs (cycle, dep on a
 * deleted task) come from the database, so they are tested as inputs and not
 * assumed away.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSeriesGraph,
  formatElapsed,
  hasSeriesGraph,
  parseDeps,
  type SeriesTask,
} from './series-graph.js';

const SERIES = 'series-1';

function task(
  id: string,
  over: Omit<Partial<SeriesTask>, 'deps'> & { deps?: string[] } = {},
): SeriesTask {
  const { deps, ...rest } = over;
  return {
    id,
    title: `task ${id}`,
    agent_name: 'agent',
    status: 'PENDING',
    series_id: SERIES,
    type: 'code',
    updated_at: 0,
    ...rest,
    deps: JSON.stringify(deps ?? []),
  };
}

function rankOf(graph: ReturnType<typeof buildSeriesGraph>, id: string): number {
  const node = graph.nodes.find((n) => n.id === id);
  assert.ok(node, `node ${id} missing from the graph`);
  return node.rank;
}

// ── The card icon ────────────────────────────────────────────────────────────

test('the graph icon is absent without a series and present with one', () => {
  assert.equal(hasSeriesGraph({ series_id: null }), false);
  assert.equal(hasSeriesGraph({ series_id: undefined }), false);
  // A blank string is a null that survived a round-trip through the DB.
  assert.equal(hasSeriesGraph({ series_id: '   ' }), false);
  assert.equal(hasSeriesGraph({ series_id: SERIES }), true);
});

test('parseDeps tolerates every malformed shape the TEXT column can hold', () => {
  assert.deepEqual(parseDeps(null), []);
  assert.deepEqual(parseDeps(''), []);
  assert.deepEqual(parseDeps('not json'), []);
  assert.deepEqual(parseDeps('{"a":1}'), []);
  assert.deepEqual(parseDeps('["a", 3, "", "b"]'), ['a', 'b']);
});

// ── Topological rank ─────────────────────────────────────────────────────────

test('topological rank on a DAG with two roots and one convergence', () => {
  // a ─┐            d = the convergence: it cannot start before BOTH branches.
  // b ─┴→ c → d     Ranks: a,b = 0 (parallel wave), c = 1, d = 2.
  const graph = buildSeriesGraph(
    [
      task('a'),
      task('b'),
      task('c', { deps: ['a', 'b'] }),
      task('d', { deps: ['c', 'b'] }),
    ],
    { seriesId: SERIES },
  );
  assert.equal(rankOf(graph, 'a'), 0);
  assert.equal(rankOf(graph, 'b'), 0);
  assert.equal(rankOf(graph, 'c'), 1);
  assert.equal(rankOf(graph, 'd'), 2);
  assert.equal(graph.hasCycle, false);
  assert.deepEqual(graph.ranks.map((col) => col.map((n) => n.id)), [['a', 'b'], ['c'], ['d']]);
});

test('tasks of another series are not part of the graph', () => {
  const graph = buildSeriesGraph(
    [task('a'), task('x', { series_id: 'other' }), task('b', { deps: ['a'] })],
    { seriesId: SERIES },
  );
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ['a', 'b']);
});

test('a single-node series still renders one node and one column', () => {
  const graph = buildSeriesGraph([task('a')], { seriesId: SERIES });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.ranks.length, 1);
  assert.equal(graph.hasCycle, false);
});

test('an empty series produces no column rather than an empty phantom one', () => {
  const graph = buildSeriesGraph([task('a', { series_id: 'other' })], { seriesId: SERIES });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.ranks, []);
});

// ── Guard rails ──────────────────────────────────────────────────────────────

test('a cycle in the deps does not loop and keeps every node', () => {
  // a → b → c → a, plus d hanging off the cycle: nothing can be ranked, so
  // everything lands in the reported cycle - and above all the call returns.
  const graph = buildSeriesGraph(
    [
      task('a', { deps: ['c'] }),
      task('b', { deps: ['a'] }),
      task('c', { deps: ['b'] }),
      task('d', { deps: ['c'] }),
    ],
    { seriesId: SERIES },
  );
  assert.equal(graph.hasCycle, true);
  // Termination alone is not enough: the graph has to stay complete.
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...graph.cycleIds].sort(), ['a', 'b', 'c', 'd']);
  assert.ok(graph.nodes.every((n) => n.inCycle));
});

test('a cycle downstream of a healthy root leaves that root ranked', () => {
  const graph = buildSeriesGraph(
    [task('root'), task('a', { deps: ['root', 'b'] }), task('b', { deps: ['a'] })],
    { seriesId: SERIES },
  );
  assert.equal(graph.hasCycle, true);
  assert.equal(rankOf(graph, 'root'), 0);
  assert.deepEqual([...graph.cycleIds].sort(), ['a', 'b']);
});

test('a dep on a non-existent task is ignored, no ghost node', () => {
  const graph = buildSeriesGraph(
    [task('a'), task('b', { deps: ['a', 'deleted-task'] })],
    { seriesId: SERIES },
  );
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.ignoredDeps, 1);
  assert.equal(rankOf(graph, 'b'), 1);
});

// ── Chain folding ────────────────────────────────────────────────────────────

test('the review/merge/doc chain is folded under its code task', () => {
  const graph = buildSeriesGraph(
    [
      task('code'),
      task('review', { type: 'review', deps: ['code'] }),
      task('merge', { type: 'merge', deps: ['review'] }),
      task('doc', { type: 'doc', deps: ['merge'] }),
    ],
    { seriesId: SERIES },
  );
  assert.deepEqual(graph.nodes.map((n) => n.id), ['code']);
  assert.deepEqual(graph.nodes[0]?.satellites.map((s) => s.id), ['review', 'merge', 'doc']);
});

test('a code-group merge with several code parents stays a node of its own', () => {
  const graph = buildSeriesGraph(
    [task('a'), task('b'), task('m', { type: 'merge', deps: ['a', 'b'] })],
    { seriesId: SERIES },
  );
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ['a', 'b', 'm']);
  assert.equal(rankOf(graph, 'm'), 1);
});

test('an edge crossing a folded node is rewired onto its host', () => {
  // codeB depends on the merge of codeA. Folding merge under codeA must not
  // cost codeB its predecessor, otherwise it drops back to rank 0.
  const graph = buildSeriesGraph(
    [
      task('codeA'),
      task('merge', { type: 'merge', deps: ['codeA'] }),
      task('codeB', { deps: ['merge'] }),
    ],
    { seriesId: SERIES },
  );
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ['codeA', 'codeB']);
  assert.equal(rankOf(graph, 'codeB'), 1);
  assert.deepEqual(graph.edges, [{ from: 'codeA', to: 'codeB' }]);
});

// ── Blocked propagation ──────────────────────────────────────────────────────

test('a BLOCKED task dims everything it holds downstream', () => {
  const graph = buildSeriesGraph(
    [
      task('free'),
      task('blocked', { status: 'BLOCKED' }),
      task('held', { deps: ['blocked'] }),
      task('heldFar', { deps: ['held'] }),
    ],
    { seriesId: SERIES },
  );
  const by = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(by.get('free')?.blockedUpstream, false);
  // The blocked node itself is red, not dimmed.
  assert.equal(by.get('blocked')?.blockedUpstream, false);
  assert.equal(by.get('held')?.blockedUpstream, true);
  assert.equal(by.get('heldFar')?.blockedUpstream, true);
});

test('blocked propagation terminates on a cyclic graph', () => {
  const graph = buildSeriesGraph(
    [
      task('a', { status: 'BLOCKED', deps: ['c'] }),
      task('b', { deps: ['a'] }),
      task('c', { deps: ['b'] }),
    ],
    { seriesId: SERIES },
  );
  assert.equal(graph.nodes.length, 3);
  assert.ok(graph.nodes.filter((n) => n.blockedUpstream).length >= 2);
});

test('a blocked satellite blocks its host', () => {
  const graph = buildSeriesGraph(
    [
      task('code'),
      task('review', { type: 'review', status: 'BLOCKED', deps: ['code'] }),
      task('next', { deps: ['code'] }),
    ],
    { seriesId: SERIES },
  );
  assert.equal(graph.nodes.find((n) => n.id === 'next')?.blockedUpstream, true);
});

// ── Focus ────────────────────────────────────────────────────────────────────

test('the origin node is highlighted when opened from a card icon', () => {
  const graph = buildSeriesGraph([task('a'), task('b', { deps: ['a'] })], {
    seriesId: SERIES,
    focusId: 'b',
  });
  const focused = graph.nodes.filter((n) => n.focused);
  assert.deepEqual(focused.map((n) => n.id), ['b']);
  assert.equal(focused[0]?.focusedSatelliteId, null);
});

test('no node is highlighted when the graph is opened from the series id', () => {
  const graph = buildSeriesGraph([task('a'), task('b', { deps: ['a'] })], { seriesId: SERIES });
  assert.equal(graph.nodes.some((n) => n.focused), false);
  assert.equal(graph.focusId, null);
});

test('focusing a folded task highlights its host and names the satellite', () => {
  const graph = buildSeriesGraph(
    [task('code'), task('review', { type: 'review', deps: ['code'] })],
    { seriesId: SERIES, focusId: 'review' },
  );
  const host = graph.nodes.find((n) => n.id === 'code');
  assert.equal(host?.focused, true);
  assert.equal(host?.focusedSatelliteId, 'review');
});

// ── Elapsed time ─────────────────────────────────────────────────────────────

test('formatElapsed stays compact from the second to the day', () => {
  const t0 = 1_000_000;
  assert.equal(formatElapsed(t0, t0 + 30_000), '<1m');
  assert.equal(formatElapsed(t0, t0 + 4 * 60_000), '4m');
  assert.equal(formatElapsed(t0, t0 + 125 * 60_000), '2h 05m');
  assert.equal(formatElapsed(t0, t0 + 3 * 24 * 3_600_000), '3d');
  // A clock skew must not produce a negative elapsed time.
  assert.equal(formatElapsed(t0, t0 - 60_000), '<1m');
});
