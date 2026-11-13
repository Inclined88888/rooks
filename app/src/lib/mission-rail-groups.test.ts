import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMissionRail, missionRoots } from './mission-rail-groups';

type Row = { id: string; origin?: string | null; parent_mission_id?: string | null; role: string };

const row = (id: string, role: string, origin: string, parent?: string): Row => ({ id, role, origin, parent_mission_id: parent ?? null });

// Most recent first, as the daemon sorts the list.
const rows: Row[] = [
  row('review', 'reviewer', 'task', 'orch'),
  row('chat', 'main', 'user'),
  row('spawned', 'research', 'agent', 'code'),
  row('code', 'coder', 'task', 'orch'),
  row('orch', 'orchestrator', 'user'),
  row('orphan', 'coder', 'task', 'gone'),
  row('wake', 'main', 'agent'),
];

const view = (opts: Partial<Parameters<typeof buildMissionRail<Row>>[1]> = {}) => buildMissionRail(rows, {
  group: true, hideAutomated: false, openMissionId: null, roleOf: (m) => m.role, role: 'all', ...opts,
});
const shape = (v: ReturnType<typeof view>) => v.entries.map((e) => [e.mission.id, e.children.map((c) => c.id)]);

test('each mission lands under its highest listed ancestor, one level deep', () => {
  const roots = missionRoots(rows);
  assert.equal(roots.get('spawned'), 'orch', 'a mission spawned by the coder climbs to the orchestrator');
  assert.equal(roots.get('orphan'), 'orphan', 'a parent missing from the list leaves the row flat');
  assert.deepEqual(shape(view()), [
    ['orch', ['review', 'spawned', 'code']],
    ['chat', []],
    ['orphan', []],
    ['wake', []],
  ]);
});

test('a group takes the place of its most recent member', () => {
  assert.equal(view().entries[0]?.mission.id, 'orch');
});

test('a cycle in the parent chain leaves its missions flat instead of looping', () => {
  const loop = [
    { id: 'a', parent_mission_id: 'b' },
    { id: 'b', parent_mission_id: 'a' },
    { id: 'c', parent_mission_id: 'a' },
  ];
  const roots = missionRoots(loop);
  assert.deepEqual([...roots], [['a', 'a'], ['b', 'b'], ['c', 'c']]);
  const self = missionRoots([{ id: 's', parent_mission_id: 's' }]);
  assert.equal(self.get('s'), 's');
});

test('ungrouped, every row is flat and the automated filter applies to all', () => {
  const v = view({ group: false, hideAutomated: true });
  assert.deepEqual(shape(v), [['chat', []], ['orch', []]]);
  assert.equal(v.total, 2);
});

test('hidden automated missions stay visible inside a group; flat ones go', () => {
  assert.deepEqual(shape(view({ hideAutomated: true })), [
    ['orch', ['review', 'spawned', 'code']],
    ['chat', []],
  ]);
});

test('the open mission stays listed whatever its origin', () => {
  assert.deepEqual(shape(view({ hideAutomated: true, openMissionId: 'wake' })).map(([id]) => id), ['orch', 'chat', 'wake']);
});

test('the role filter applies to rows; a group with no passing row disappears', () => {
  const coder = view({ role: 'coder' });
  assert.equal(coder.activeRole, 'coder');
  assert.deepEqual(shape(coder), [['orch', ['code']], ['orphan', []]]);
  assert.equal(coder.count, 2);
  assert.deepEqual(shape(view({ role: 'main' })), [['chat', []], ['wake', []]]);
});

test('under a role filter, a head of another role is marked as context and left out of the count', () => {
  const coder = view({ role: 'coder' });
  assert.deepEqual(coder.entries.map((e) => [e.mission.id, e.context]), [['orch', true], ['orphan', false]]);
  assert.equal(coder.count, 2, 'the orchestrator head does not count as a coder mission');
  const orchestrator = view({ role: 'orchestrator' });
  assert.deepEqual(orchestrator.entries.map((e) => [e.mission.id, e.context, e.children.length]), [['orch', false, 0]]);
  assert.ok(view().entries.every((e) => !e.context), 'no head is context without a role filter');
  assert.ok(view({ group: false, role: 'coder' }).entries.every((e) => !e.context), 'ungrouped rows are never context');
});

test('roles are counted over the rows the other filters leave', () => {
  const v = view({ group: false, hideAutomated: true });
  assert.deepEqual(v.roles, [{ role: 'main', count: 1 }, { role: 'orchestrator', count: 1 }]);
  assert.equal(view().total, rows.length);
});

test('a role no longer present falls back to all', () => {
  const v = view({ group: false, hideAutomated: true, role: 'coder' });
  assert.equal(v.activeRole, 'all');
  assert.equal(v.count, v.total);
});
