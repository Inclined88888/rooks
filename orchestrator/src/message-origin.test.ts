/**
 * Origin derivation for inbox messages. Pure module: no SQLite involved.
 * `node --test --import tsx src/message-origin.test.ts` (or `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageOrigin } from './message-origin.js';

test('free text between two agents is an agent message', () => {
  assert.equal(messageOrigin({ from_agent: 'rooks.coder', payload: 'hello' }), 'agent');
  assert.equal(
    messageOrigin({ from_agent: 'rooks.coder', payload: 'hello' }, { source_channel: 'agent', routine_id: null }),
    'agent',
  );
});

test('payload kind wins over the sender name', () => {
  assert.equal(
    messageOrigin({ from_agent: 'rooks.coder', payload: JSON.stringify({ kind: 'mission_complete' }) }),
    'mission_return',
  );
  assert.equal(
    messageOrigin({ from_agent: 'rooks.coder', payload: JSON.stringify({ kind: 'task_closed' }) }),
    'task_return',
  );
  assert.equal(
    messageOrigin({ from_agent: 'orchestrator-wake', payload: JSON.stringify({ kind: 'wake_recap' }) }),
    'wake',
  );
  assert.equal(
    messageOrigin({ from_agent: 'orchestrator', payload: JSON.stringify({ kind: 'system_alert' }) }),
    'system_alert',
  );
});

test('well-known pseudo senders are recognised without a JSON payload', () => {
  assert.equal(messageOrigin({ from_agent: 'cockpit', payload: 'Idea from TO DO LATER' }), 'cockpit');
  assert.equal(messageOrigin({ from_agent: 'orchestrator-wake', payload: 'text' }), 'wake');
  assert.equal(messageOrigin({ from_agent: 'orchestrator', payload: 'text' }), 'system_alert');
});

test('a sender mission spawned by a routine marks the message as routine', () => {
  assert.equal(
    messageOrigin({ from_agent: 'rooks.main', payload: 'daily digest' }, { source_channel: 'routine', routine_id: null }),
    'routine',
  );
  assert.equal(
    messageOrigin({ from_agent: 'rooks.main', payload: 'daily digest' }, { source_channel: null, routine_id: 'r1' }),
    'routine',
  );
});

test('a JSON payload with an unknown kind stays an agent message', () => {
  assert.equal(
    messageOrigin({ from_agent: 'rooks.coder', payload: JSON.stringify({ kind: 'custom', x: 1 }) }),
    'agent',
  );
  assert.equal(messageOrigin({ from_agent: 'rooks.coder', payload: '{not json' }), 'agent');
});
