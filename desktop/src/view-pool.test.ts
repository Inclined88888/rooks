import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_VIEWS_PER_WINDOW, ViewPool, type PooledView } from './view-pool.js';

let next = 100;
const page = (machineId: string | null): PooledView<string> => ({ contentsId: next++, machineId, view: `page:${machineId}` });
const machines = (pool: ViewPool<string>) => pool.list().map((p) => p.machineId);

test('V4: a window keeps three machines alive', () => {
  assert.equal(LIVE_VIEWS_PER_WINDOW, 3);
  assert.throws(() => new ViewPool(0), /at least one/);
});

test('V4: entering a machine creates its page once, then shows the same page again', () => {
  const pool = new ViewPool<string>();
  let created = 0;
  const make = (id: string | null) => () => { created += 1; return page(id); };
  const a = pool.enter('a', make('a'));
  assert.equal(a.created, true);
  assert.equal(a.leaving, null);
  const b = pool.enter('b', make('b'));
  assert.equal(b.leaving, a.entering, 'the page that was on screen is hidden, not closed');
  const back = pool.enter('a', make('a'));
  assert.equal(back.created, false);
  assert.equal(back.entering, a.entering, 'the very same page: its state is intact');
  assert.equal(back.leaving, b.entering);
  assert.equal(created, 2);
  assert.equal(pool.active, a.entering);
  assert.deepEqual(machines(pool), ['b', 'a']);
  const same = pool.enter('a', make('a'));
  assert.equal(same.leaving, null, 'entering the machine on screen changes nothing');
  assert.deepEqual(same.evicted, []);
});

test('V4: a fourth machine closes the one shown least recently, never the one entered', () => {
  const pool = new ViewPool<string>();
  const a = pool.enter('a', () => page('a')).entering;
  pool.enter('b', () => page('b'));
  pool.enter('c', () => page('c'));
  pool.enter('a', () => page('a'));
  const d = pool.enter('d', () => page('d'));
  assert.deepEqual(d.evicted.map((p) => p.machineId), ['b'], 'a was shown again after b: b goes');
  assert.deepEqual(machines(pool), ['c', 'a', 'd']);
  assert.equal(pool.find('b'), null);
  assert.equal(pool.isClosing(d.evicted[0]!.contentsId), true);
  assert.equal(pool.byContents(d.evicted[0]!.contentsId)?.machineId, 'b', 'a closing page still names its machine on its last requests');
  assert.equal(pool.byContents(a.contentsId), a);
  const one = new ViewPool<string>(1);
  one.enter('x', () => page('x'));
  assert.deepEqual(one.enter('y', () => page('y')).evicted.map((p) => p.machineId), ['x']);
  assert.deepEqual(machines(one), ['y']);
});

test('V4: coming back to a closed machine builds a new page, its old one forgotten for good', () => {
  const pool = new ViewPool<string>();
  const b = pool.enter('b', () => page('b')).entering;
  pool.enter('c', () => page('c'));
  pool.enter('d', () => page('d'));
  const e = pool.enter('e', () => page('e'));
  assert.deepEqual(e.evicted, [b]);
  assert.equal(pool.forget(b.contentsId), b, 'its webContents is destroyed');
  assert.equal(pool.byContents(b.contentsId), null);
  assert.equal(pool.closingCount, 0);
  assert.deepEqual(pool.everyPage().map((p) => p.machineId), ['c', 'd', 'e'], 'nothing of it is left behind');
  const again = pool.enter('b', () => page('b'));
  assert.equal(again.created, true);
  assert.notEqual(again.entering.contentsId, b.contentsId);
  assert.deepEqual(again.evicted.map((p) => p.machineId), ['c']);
});

test('V4: a closing page the user keeps comes back, and the limit applies again on the next entry', () => {
  const pool = new ViewPool<string>();
  const a = pool.enter('a', () => page('a')).entering;
  pool.enter('b', () => page('b'));
  pool.enter('c', () => page('c'));
  pool.enter('d', () => page('d'));
  assert.equal(pool.keep(a.contentsId), true, 'unsaved changes: the user stayed');
  assert.equal(pool.keep(a.contentsId), false);
  assert.deepEqual(machines(pool), ['a', 'b', 'c', 'd']);
  const front = pool.enter('a', () => page('a'));
  assert.equal(front.created, false);
  assert.deepEqual(front.evicted.map((p) => p.machineId), ['b']);
  assert.deepEqual(machines(pool), ['c', 'd', 'a']);
});

test('V4: closing a window moves its pages to closing one by one; a destroyed page leaves no trace', () => {
  const pool = new ViewPool<string>();
  const pages = ['a', 'b', 'c'].map((id) => pool.enter(id, () => page(id)).entering);
  assert.equal(pool.close(pages[0]!.contentsId), true);
  assert.equal(pool.close(pages[0]!.contentsId), false, 'already closing');
  assert.equal(pool.close(999), false);
  assert.deepEqual(pool.closingPages(), [pages[0]]);
  assert.equal(pool.active, pages[2]);
  for (const p of pages) { pool.close(p.contentsId); pool.forget(p.contentsId); }
  assert.equal(pool.size, 0);
  assert.equal(pool.closingCount, 0);
  assert.equal(pool.active, null);
  assert.deepEqual(pool.everyPage(), []);
  for (const p of pages) assert.equal(pool.byContents(p.contentsId), null);
  assert.equal(pool.forget(pages[0]!.contentsId), null, 'forgetting twice is harmless');
});

test('V4: a page is filed under its own machine and contents id only once', () => {
  const pool = new ViewPool<string>();
  const a = pool.enter('a', () => page('a')).entering;
  assert.throws(() => pool.enter('b', () => page('c')), /another machine/);
  assert.throws(() => pool.enter('b', () => ({ ...page('b'), contentsId: a.contentsId })), /already in the window/);
  assert.deepEqual(machines(pool), ['a']);
  const cookie = pool.enter(null, () => page(null));
  assert.equal(cookie.entering.machineId, null, 'a page without a machine of its own follows the cookie');
  assert.equal(pool.find(null), cookie.entering);
});
