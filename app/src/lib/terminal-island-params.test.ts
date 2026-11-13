/**
 * A terminal tab shows an open session by id, or — when an agent's layout asks
 * for it — a new shell not started yet (`fresh`), which needs no id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTerminalIslandParams } from './terminal-island-params';

test('an open session is kept by its id and scope', () => {
  assert.deepEqual(parseTerminalIslandParams({ sessionId: 's1', scope: 'project:rooks' }), { scope: 'project:rooks', sessionId: 's1' });
  assert.deepEqual(parseTerminalIslandParams({ sessionId: 's1' }), { scope: null, sessionId: 's1' });
});

test('a fresh shell needs no id', () => {
  assert.deepEqual(parseTerminalIslandParams({ fresh: true, scope: 'agent:nimbus.main' }), { scope: 'agent:nimbus.main', fresh: true });
  assert.deepEqual(parseTerminalIslandParams({ fresh: true }), { scope: null, fresh: true });
});

test('neither an id nor fresh, or a bad scope: refused', () => {
  assert.equal(parseTerminalIslandParams({}), null);
  assert.equal(parseTerminalIslandParams({ fresh: false }), null);
  assert.equal(parseTerminalIslandParams({ fresh: true, scope: 'host:/' }), null);
  assert.equal(parseTerminalIslandParams({ sessionId: 'bad id!' }), null);
});
