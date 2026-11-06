import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_FILTER } from './kanban-filters';
import {
  QUEUE_RAIL_PROJECT_KEY, filterQueueByProject, readQueueRailProject, writeQueueRailProject,
} from './queue-rail-filter';

const projectByAgent = new Map<string, string | null>([
  ['alpha.coder', 'alpha'], ['beta.coder', 'beta'], ['loose', null],
]);
const missions = [{ id: 'm1', agent_name: 'alpha.coder' }, { id: 'm2', agent_name: 'beta.coder' }, { id: 'm3', agent_name: 'loose' }];
const tasks = [
  { id: 't1', agent_name: 'alpha.coder' },
  { id: 't2', agent_name: 'beta.coder' },
  { id: 't3', agent_name: 'beta.coder', project: 'alpha' },
  { id: 't4', agent_name: 'loose' },
];

test('SUG-0033: no project selected keeps every mission and task', () => {
  for (const slug of [null, ALL_FILTER]) {
    const out = filterQueueByProject(missions, tasks, slug, projectByAgent);
    assert.equal(out.missions.length, 3);
    assert.equal(out.tasks.length, 4);
  }
});

test('SUG-0033: a project keeps its agents\' missions and its tasks', () => {
  const out = filterQueueByProject(missions, tasks, 'alpha', projectByAgent);
  assert.deepEqual(out.missions.map((m) => m.id), ['m1']);
  // t3 is created for alpha on an agent of beta: the task's own project wins.
  assert.deepEqual(out.tasks.map((t) => t.id), ['t1', 't3']);
});

test('SUG-0033: an agent without a project is hidden while a project is selected', () => {
  const out = filterQueueByProject(missions, tasks, 'beta', projectByAgent);
  assert.deepEqual(out.missions.map((m) => m.id), ['m2']);
  assert.deepEqual(out.tasks.map((t) => t.id), ['t2']);
});

test('SUG-0033: the choice is kept per browser and cleared on "all"', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
  assert.equal(readQueueRailProject(storage), ALL_FILTER);
  writeQueueRailProject(storage, 'alpha');
  assert.equal(data.get(QUEUE_RAIL_PROJECT_KEY), 'alpha');
  assert.equal(readQueueRailProject(storage), 'alpha');
  writeQueueRailProject(storage, ALL_FILTER);
  assert.equal(readQueueRailProject(storage), ALL_FILTER);
  assert.equal(readQueueRailProject(null), ALL_FILTER);
});
