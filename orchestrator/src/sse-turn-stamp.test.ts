/**
 * The "turn done" sound plays once across windows only if every stream stamps
 * the same turn with the same `at`: the client's dedup key is built from it.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { turnDoneStamp } = await import('./sse.js');

test('every stream stamps one turn the same way, two turns differently', async () => {
  const turn = { kind: 'turn_complete', missionId: 'm1' };
  const first = turnDoneStamp(turn);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(turnDoneStamp(turn), first, 'a second window gets the same stamp');
  const next = { kind: 'turn_complete', missionId: 'm1' };
  assert.notEqual(turnDoneStamp(next), first);
});
