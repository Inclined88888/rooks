import assert from 'node:assert/strict';
import test from 'node:test';
import { handoverKey, handoverOf, readHandover, rowHandover } from './layout-handover';
import { workspaceRowHandover } from './workspace-route';

test('a chain lists the previous row first, consumed, then the shared one, kept', () => {
  assert.deepEqual(rowHandover('old.widgets', 'cockpit'), [{ scope: 'old.widgets', consumed: true }, { scope: 'cockpit' }]);
  assert.deepEqual(rowHandover(null, 'cockpit'), [{ scope: 'cockpit' }]);
  assert.deepEqual(rowHandover(undefined), []);
  assert.deepEqual(handoverOf('chat.columns'), [{ scope: 'chat.columns' }], 'a bare scope is the historical kept legacy');
  assert.deepEqual(handoverOf(undefined), []);
});

test('a view row hands over from the same suffix under the previous key', () => {
  assert.deepEqual(workspaceRowHandover('v2.old', 'columns', 'chat.columns'), [{ scope: 'v2.old.columns', consumed: true }, { scope: 'chat.columns' }]);
  assert.deepEqual(workspaceRowHandover(null, 'islands'), []);
});

test('the identity of a chain is its content, kept and consumed sources apart', () => {
  assert.equal(handoverKey(rowHandover('a', 'b')), handoverKey(rowHandover('a', 'b')));
  assert.notEqual(handoverKey(rowHandover('a')), handoverKey('a'));
  assert.equal(handoverKey(undefined), '');
});

test('the walk stops at the first source holding something, or at the first that cannot be read', async () => {
  const rows = new Map<string, unknown>([['b', { x: 1 }], ['c', { x: 2 }]]);
  const seen: string[] = [];
  const load = async (scope: string) => {
    seen.push(scope);
    return scope === 'broken' ? { ok: false, raw: null } : { ok: true, raw: rows.get(scope) ?? null };
  };
  assert.deepEqual(await readHandover(rowHandover('a', 'b'), load), { ok: true, raw: { x: 1 }, from: { scope: 'b' } });
  assert.deepEqual(seen, ['a', 'b']);
  seen.length = 0;
  assert.deepEqual(await readHandover(rowHandover('broken', 'c'), load), { ok: false });
  assert.deepEqual(seen, ['broken'], 'the shared row is not read past a failure');
  assert.deepEqual(await readHandover(rowHandover('a', 'z'), load), { ok: true, raw: null, from: null });
});
