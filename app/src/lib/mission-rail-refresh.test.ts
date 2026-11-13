import test from 'node:test';
import assert from 'node:assert/strict';

import { railFrameMatters } from './mission-rail-refresh';

const rail = [
  { id: 'idle', turn_active: false },
  { id: 'busy', turn_active: true },
];
const frame = (body: Record<string, unknown>) => JSON.stringify(body);

test('a started mission always refreshes: its project is not known client-side', () => {
  assert.equal(railFrameMatters('mission_started', frame({ kind: 'mission_started', missionId: 'new', agent: 'x' }), rail), true);
});

test('an end refreshes only for a mission of the rail', () => {
  assert.equal(railFrameMatters('turn_complete', frame({ kind: 'turn_complete', missionId: 'busy' }), rail), true);
  assert.equal(railFrameMatters('mission_complete', frame({ kind: 'mission_complete', missionId: 'idle', status: 'completed' }), rail), true);
  assert.equal(railFrameMatters('turn_complete', frame({ kind: 'turn_complete', missionId: 'elsewhere' }), rail), false);
});

test('a user event starts a turn on an idle rail mission, and only then', () => {
  assert.equal(railFrameMatters('event', frame({ kind: 'event', missionId: 'idle', type: 'user', payload: {} }), rail), true);
  assert.equal(railFrameMatters('event', frame({ kind: 'event', missionId: 'busy', type: 'user', payload: {} }), rail), false);
  assert.equal(railFrameMatters('event', frame({ kind: 'event', missionId: 'elsewhere', type: 'user', payload: {} }), rail), false);
});

test('the token stream and other event types never refresh', () => {
  assert.equal(railFrameMatters('event', frame({ kind: 'event', missionId: 'idle', type: 'system', payload: { subtype: 'thinking_tokens' } }), rail), false);
  assert.equal(railFrameMatters('event', frame({ kind: 'event', missionId: 'idle', type: 'assistant', payload: { text: '"user"' } }), rail), false);
  assert.equal(railFrameMatters('permission_request', frame({ missionId: 'idle' }), rail), false);
});

test('a malformed frame is ignored', () => {
  assert.equal(railFrameMatters('turn_complete', 'not json', rail), false);
  assert.equal(railFrameMatters('event', '{"type":"user"', rail), false);
  assert.equal(railFrameMatters('turn_complete', frame({ kind: 'turn_complete' }), rail), false);
});
