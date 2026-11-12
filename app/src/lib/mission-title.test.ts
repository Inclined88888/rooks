import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMissionTitleChange, missionDisplayTitle, parseMissionTitleChange } from './mission-title';

test('the displayed name: stored title, else task title, else the first line of the brief without the TASK_ID preamble', () => {
  assert.equal(missionDisplayTitle({ id: 'a', title: '  Relecture   du README ', mission: 'x' }), 'Relecture du README');
  assert.equal(missionDisplayTitle({ id: 'a', title: '', task_title: 'feat X', mission: 'x' }), 'feat X');
  assert.equal(missionDisplayTitle({ id: 'a', mission: 'TASK_ID: 8841bfb8-5c3a-4905-8adb-bf6742987b69\n\nFirst line\nSecond' }), 'First line');
  assert.equal(missionDisplayTitle({ id: 'a', mission: '   ' }, '(empty)'), '(empty)');
});

test('a stream event is parsed defensively', () => {
  assert.deepEqual(parseMissionTitleChange(JSON.stringify({ kind: 'mission_title_changed', missionId: 'm1', title: 'T', source: 'generated' })),
    { missionId: 'm1', title: 'T', source: 'generated' });
  assert.deepEqual(parseMissionTitleChange(JSON.stringify({ missionId: 'm1', title: null, source: null })), { missionId: 'm1', title: null, source: null });
  assert.deepEqual(parseMissionTitleChange(JSON.stringify({ missionId: 'm1', title: 'T', source: 'weird' })), { missionId: 'm1', title: 'T', source: null });
  assert.equal(parseMissionTitleChange('{'), null);
  assert.equal(parseMissionTitleChange(JSON.stringify({ title: 'T' })), null);
});

test('applying an event touches only its row, and nothing when nothing changes', () => {
  const list = [{ id: 'm1', title: null as string | null }, { id: 'm2', title: 'Kept' }];
  const next = applyMissionTitleChange(list, { missionId: 'm1', title: 'Generated', source: 'generated' });
  assert.notEqual(next, list);
  assert.deepEqual(next, [{ id: 'm1', title: 'Generated', title_source: 'generated' }, { id: 'm2', title: 'Kept' }]);
  assert.equal(applyMissionTitleChange(next, { missionId: 'm1', title: 'Generated', source: 'generated' }), next, 'same array when unchanged');
  assert.equal(applyMissionTitleChange(next, { missionId: 'absent', title: 'x', source: 'manual' }), next, 'an unknown mission is not added');
  const cleared = applyMissionTitleChange(next, { missionId: 'm1', title: null, source: null });
  assert.deepEqual(cleared[0], { id: 'm1', title: null, title_source: null });
});
