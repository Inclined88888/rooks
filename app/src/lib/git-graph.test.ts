/**
 * The commit graph's layout (TODO #278, volet 3): which lane a commit sits
 * on, which edges join it to its children above and its parents below, and
 * what its pills say. The SVG only draws what these return.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, pathTail, pillsFor } from './git-graph';
import type { GitCommit, GitRef, GitWorktree } from './git-store';

const c = (hash: string, parents: string[], refs: GitRef[] = []): GitCommit => ({
  hash, short: hash.slice(0, 7), parents, author: 'a', ts: 0, subject: hash, refs,
});

const wt = (over: Partial<GitWorktree>): GitWorktree => ({
  path: '/repo', head: null, branch: null, main: false, current: false,
  bare: false, detached: false, locked: null, prunable: null, ...over,
});

test('a straight history stays on one lane', () => {
  const { rows, lanes } = layoutGraph([c('c3', ['c2']), c('c2', ['c1']), c('c1', [])]);
  assert.equal(lanes, 1);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  // The tip has nothing above it, the root nothing below.
  assert.deepEqual(rows[0]!.edges, [{ half: 'bottom', from: 0, to: 0, color: 0 }]);
  assert.deepEqual(rows[2]!.edges, [{ half: 'top', from: 0, to: 0, color: 0 }]);
});

test('a branch opens a second lane and joins the first at its fork point', () => {
  // main: m2 → base ; feature: f1 → base
  const { rows, lanes } = layoutGraph([
    c('m2', ['base']),
    c('f1', ['base']),
    c('base', []),
  ]);
  assert.equal(lanes, 2);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0]);
  // f1 leaves its own lane towards the lane already waiting for `base`.
  assert.ok(rows[1]!.edges.some((e) => e.half === 'bottom' && e.from === 1 && e.to === 0));
  // …and the main line keeps going straight past it.
  assert.ok(rows[1]!.edges.some((e) => e.half === 'bottom' && e.from === 0 && e.to === 0));
  assert.notEqual(rows[1]!.color, rows[0]!.color);
});

test('a merge opens a lane for its second parent, which closes on that parent', () => {
  const { rows } = layoutGraph([
    c('merge', ['m1', 'f1']),
    c('f1', ['base']),
    c('m1', ['base']),
    c('base', []),
  ]);
  const [merge, f1, m1, base] = rows;
  assert.equal(merge!.lane, 0);
  assert.ok(merge!.edges.some((e) => e.half === 'bottom' && e.from === 0 && e.to === 1));
  assert.equal(f1!.lane, 1);
  assert.equal(m1!.lane, 0);
  // The feature lane hands `base` over to the main line, which stays straight.
  assert.ok(m1!.edges.some((e) => e.half === 'bottom' && e.from === 1 && e.to === 0));
  assert.equal(base!.lane, 0);
  assert.deepEqual(base!.edges, [{ half: 'top', from: 0, to: 0, color: m1!.color }]);
});

test('a lane passing by draws straight in both halves', () => {
  const { rows } = layoutGraph([c('a', ['x']), c('b', ['y']), c('x', []), c('y', [])]);
  const passing = rows[1]!.edges.filter((e) => e.from === 0 && e.to === 0);
  assert.deepEqual(passing.map((e) => e.half).sort(), ['bottom', 'top']);
});

test('a freed lane is reused instead of widening the graph', () => {
  const { lanes } = layoutGraph([
    c('a', ['r']), c('b', ['r']), c('r', []),
    c('d', ['s']), c('e', ['s']), c('s', []),
  ]);
  assert.equal(lanes, 2);
});

test('pills: the current branch first, its remote twin folded, a busy branch shows its worktree', () => {
  const commit = c('abc', [], [
    { kind: 'branch', name: 'feat' },
    { kind: 'head', name: 'HEAD' },
    { kind: 'branch', name: 'main' },
    { kind: 'remote', name: 'origin/main' },
    { kind: 'remote', name: 'origin/other' },
    { kind: 'tag', name: 'v1' },
  ]);
  const pills = pillsFor(commit, [wt({ path: '/wt/feat', branch: 'feat' }), wt({ path: '/repo', branch: 'main', current: true, main: true })], 'main');
  assert.deepEqual(pills, [
    { kind: 'branch', name: 'main', current: true, synced: true, worktree: null },
    { kind: 'branch', name: 'feat', current: false, synced: false, worktree: '/wt/feat' },
    { kind: 'remote', name: 'origin/other' },
    { kind: 'tag', name: 'v1' },
  ]);
});

test('pills: a detached HEAD and a detached worktree are both visible', () => {
  const commit = c('abc', [], [{ kind: 'head', name: 'HEAD' }]);
  const pills = pillsFor(commit, [
    wt({ path: 'C:\\Users\\u\\.timon\\worktrees\\task-1', head: 'abc', detached: true }),
    wt({ path: '/repo', head: 'abc', detached: true, current: true }),
  ], null);
  assert.deepEqual(pills, [
    { kind: 'head' },
    { kind: 'worktree', name: 'task-1', path: 'C:\\Users\\u\\.timon\\worktrees\\task-1' },
  ]);
});

test('pathTail reads both separators', () => {
  assert.equal(pathTail('/home/u/repo/'), 'repo');
  assert.equal(pathTail('C:/x/y'), 'y');
  assert.equal(pathTail('C:\\x\\z'), 'z');
});
