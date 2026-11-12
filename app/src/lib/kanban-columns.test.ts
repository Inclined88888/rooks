import assert from 'node:assert/strict';
import test from 'node:test';
import { columnStatus, groupByColumn } from './kanban-columns';

test('known statuses keep their own column', () => {
  const byCol = groupByColumn([
    { id: 'p', status: 'PENDING' },
    { id: 'i', status: 'IN_PROGRESS' },
    { id: 'd', status: 'DONE' },
    { id: 'b', status: 'BLOCKED' },
  ]);
  assert.deepEqual(byCol.PENDING.map((t) => t.id), ['p']);
  assert.deepEqual(byCol.IN_PROGRESS.map((t) => t.id), ['i']);
  assert.deepEqual(byCol.DONE.map((t) => t.id), ['d']);
  assert.deepEqual(byCol.BLOCKED.map((t) => t.id), ['b']);
});

test('TIM-0101: an unknown status such as CANCELLED does not throw and joins DONE', () => {
  const tasks = [
    { id: 'r', status: 'CANCELLED' },
    { id: 'x', status: 'whatever' },
    { id: 'p', status: 'PENDING' },
  ];
  let byCol: ReturnType<typeof groupByColumn<(typeof tasks)[number]>> | undefined;
  assert.doesNotThrow(() => { byCol = groupByColumn(tasks); });
  assert.deepEqual(byCol?.DONE.map((t) => t.id), ['r', 'x']);
  assert.deepEqual(byCol?.PENDING.map((t) => t.id), ['p']);
  assert.equal(byCol?.BLOCKED.length, 0);
  assert.equal(columnStatus('CANCELLED'), 'DONE');
});
