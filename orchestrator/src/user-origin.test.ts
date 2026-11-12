/**
 * Provenance of `user` chat events. Pure module: no SQLite involved.
 * `node --test --import tsx src/user-origin.test.ts` (or `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originFromSpawnSource, originOfDigest, WAKE_SENDER } from './user-origin.js';

test('human chat has no origin', () => {
  assert.equal(originFromSpawnSource(undefined), null);
  assert.equal(originFromSpawnSource({ channel: 'agent' }), null);
  assert.equal(originFromSpawnSource({ channel: 'telegram' }), null);
});

test('a sub-mission spawned by an agent names its parent', () => {
  assert.deepEqual(
    originFromSpawnSource({ channel: 'agent', meta: { parent_agent: 'rooks.main', parent_mission_id: 'm1' } }),
    { kind: 'agent', from: 'rooks.main', mission_id: 'm1' },
  );
});

test('daemon channels map to their kind', () => {
  assert.deepEqual(originFromSpawnSource({ channel: 'dispatcher', meta: { task_id: 't' } }), { kind: 'dispatcher', from: 'orchestrator' });
  assert.deepEqual(originFromSpawnSource({ channel: 'wake' }), { kind: 'wake', from: WAKE_SENDER });
  assert.deepEqual(
    originFromSpawnSource({ channel: 'fork', meta: { from: 'm0', source_agent: 'rooks.coder' } }),
    { kind: 'fork', from: 'rooks.coder', mission_id: 'm0' },
  );
  assert.deepEqual(originFromSpawnSource({ channel: 'librarian' }), { kind: 'system', from: 'orchestrator' });
});

test('digest from one agent carries its name and mission', () => {
  assert.deepEqual(
    originOfDigest([{ from_agent: 'rooks.coder', from_mission: 'm1', payload: 'done' }]),
    { kind: 'agent', from: 'rooks.coder', mission_id: 'm1' },
  );
});

test('a mission return reads as one, authored by the returning agent', () => {
  const payload = JSON.stringify({ kind: 'mission_complete', agent: 'rooks.reviewer', mission_id: 'm2' });
  assert.deepEqual(
    originOfDigest([{ from_agent: 'rooks.reviewer', from_mission: 'm2', payload }]),
    { kind: 'mission_return', from: 'rooks.reviewer', mission_id: 'm2' },
  );
});

test('several senders fall back to the wake pseudo-sender', () => {
  const origin = originOfDigest([
    { from_agent: 'rooks.coder', from_mission: 'm1', payload: JSON.stringify({ kind: 'task_closed', agent: 'rooks.coder' }) },
    { from_agent: 'rooks.reviewer', from_mission: 'm2', payload: 'text' },
  ]);
  assert.deepEqual(origin, { kind: 'task_return', from: WAKE_SENDER });
  assert.deepEqual(originOfDigest([]), { kind: 'wake', from: WAKE_SENDER });
});
