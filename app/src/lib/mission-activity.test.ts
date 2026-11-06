import test from 'node:test';
import assert from 'node:assert/strict';

import { missionActivity } from './mission-activity';

test('two running missions of the same agent both read as thinking', () => {
  const missions = [
    { id: 'a', agent_name: 'timon.coder', running: true, turn_active: true },
    { id: 'b', agent_name: 'timon.coder', running: true, turn_active: true },
  ];
  const states = missions.map((m) => missionActivity(m));
  assert.deepEqual(states, ['thinking', 'thinking']);
});

test('only the mission with an active turn is thinking', () => {
  assert.equal(missionActivity({ running: true, turn_active: true }), 'thinking');
  assert.equal(missionActivity({ running: true, turn_active: false }), 'idle');
  assert.equal(missionActivity({ running: true }), 'idle');
});

test('a pending permission wins over an active turn', () => {
  assert.equal(
    missionActivity({ running: true, turn_active: true, pending_action_at: 1 }),
    'needs_action',
  );
});
