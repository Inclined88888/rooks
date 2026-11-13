/**
 * Side-menu order: stored beside `pinned` / `hidden`, never erasing them; entries
 * with no path (the divider) keep their place; unknown paths follow the known.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV_FOOTER_MARK,
  NAV_SEPARATOR,
  applyNavOrder,
  keepAbsentPaths,
  layoutNav,
  moveKey,
  navEditIds,
  navLayoutFromIds,
  navLayoutOf,
  orderOf,
  orderedKeys,
  proposedNavLayout,
  visibleNavRows,
  withNavLayout,
  type NavRow,
} from './nav-order';

test('the stored order is read defensively', () => {
  assert.deepEqual(orderOf(null), []);
  assert.deepEqual(orderOf({ pinned: true }), []);
  assert.deepEqual(orderOf({ order: ['/b', '/a', '/a', 'javascript:x', 3, '/x?y'] }), ['/b', '/a']);
});

test('writing the menu keeps the pin and the hidden pages, and always marks the foot', () => {
  assert.deepEqual(withNavLayout({ pinned: true, hidden: ['/k'] }, { order: ['/b', '---', '/a'], footer: [] }), { pinned: true, hidden: ['/k'], order: ['/b', '---', '/a'], footer: [] });
  assert.deepEqual(withNavLayout({ pinned: true, order: ['/b'] }, { order: [], footer: ['/b'] }), { pinned: true, order: [], footer: ['/b'] });
});

test('the stored menu keeps separators, drops junk, and a path lives in one list only', () => {
  assert.deepEqual(navLayoutOf({ order: ['/a', '---', '---', '/a', 'x'], footer: ['/a', '/z', '---'] }), { order: ['/a', '---', '---'], footer: ['/z', '---'] });
  assert.deepEqual(navLayoutOf({ order: ['/a'] }), { order: ['/a'], footer: null }, 'a row from before the foot');
});

test('a page the order does not know follows the known ones in default order', () => {
  assert.deepEqual(orderedKeys(['/a', '/b', '/c', '/d'], ['/c', '/gone', '/a']), ['/c', '/a', '/b', '/d']);
});

test('keyed entries are poured back into the keyed places; the divider stays', () => {
  const entries = [{ k: '/a' }, { k: '/b' }, { d: true }, { k: '/c' }, { k: '/d' }] as Array<{ k?: string; d?: boolean }>;
  const out = applyNavOrder(entries, (e) => e.k, ['/d', '/a', '/c', '/b']);
  assert.deepEqual(out.map((e) => e.k ?? '—'), ['/d', '/a', '—', '/c', '/b']);
});

test('no order, or fewer than two keyed entries, changes nothing', () => {
  const entries = [{ k: '/a' }, { k: '/b' }];
  assert.deepEqual(applyNavOrder(entries, (e) => e.k, []), entries);
  assert.deepEqual(applyNavOrder([{ k: '/a' }], (e) => e.k, ['/a']), [{ k: '/a' }]);
});

test('a drop takes the place of the entry it lands on, either way', () => {
  assert.deepEqual(moveKey(['/a', '/b', '/c', '/d'], '/a', '/c'), ['/b', '/c', '/a', '/d']);
  assert.deepEqual(moveKey(['/a', '/b', '/c', '/d'], '/d', '/b'), ['/a', '/d', '/b', '/c']);
  assert.deepEqual(moveKey(['/a', '/b', '/c'], '/b', '/b'), ['/a', '/b', '/c']);
  assert.deepEqual(moveKey(['/a', '/b'], '/zz', '/a'), ['/a', '/b']);
  assert.deepEqual(moveKey(['/a', '/b'], '/a', '/zz'), ['/a', '/b']);
});

test('across the divider, the moved page joins the other group and the divider keeps its place', () => {
  const entries = [{ k: '/a' }, { k: '/b' }, { d: true }, { k: '/c' }] as Array<{ k?: string; d?: boolean }>;
  const out = applyNavOrder(entries, (e) => e.k, moveKey(['/a', '/b', '/c'], '/a', '/c'));
  assert.deepEqual(out.map((e) => e.k ?? '—'), ['/b', '/c', '—', '/a']);
});

type E = { k?: string };
const keyOfE = (e: E) => e.k;
const shape = (rows: NavRow<E>[]) => rows.map((r) => (r.kind === 'separator' ? '|' : r.entry.k ?? '?'));
const DEFAULTS: E[] = [{ k: '/a' }, { k: '/b' }, { k: NAV_SEPARATOR }, { k: '/c' }, {}];

test('a row from before the foot keeps the registered divider where it was', () => {
  const out = layoutNav(DEFAULTS, keyOfE, { order: ['/c', '/a', '/b'], footer: null });
  assert.deepEqual(shape(out.main), ['/c', '/a', '|', '/b', '?']);
  assert.deepEqual(out.footer, []);
});

test('a row with a foot: its separators, its foot, new pages and pathless entries last in the main list', () => {
  const entries: E[] = [...DEFAULTS, { k: '/growth' }];
  const out = layoutNav(entries, keyOfE, { order: ['/b', NAV_SEPARATOR, '/gone', '/a', NAV_SEPARATOR], footer: ['/c'] });
  assert.deepEqual(shape(out.main), ['/b', '|', '/a', '|', '?', '/growth']);
  assert.deepEqual(shape(out.footer), ['/c']);
  assert.deepEqual(out.main.filter((r) => r.kind === 'separator').map((r) => r.id), ['---0', '---1'], 'separator ids are unique');
});

test('outside the editor: hidden entries go, separators only between two shown entries', () => {
  const out = layoutNav([{ k: '/a' }, { k: '/b' }, { k: '/c' }], keyOfE, { order: ['---', '/a', '---', '---', '/b', '---', '/c', '---'], footer: [] });
  assert.deepEqual(shape(visibleNavRows(out.main, [])), ['/a', '|', '/b', '|', '/c']);
  assert.deepEqual(shape(visibleNavRows(out.main, ['/b'])), ['/a', '|', '/c']);
  assert.deepEqual(shape(visibleNavRows(out.main, ['/a', '/b'])), ['/c']);
});

test('the editing list round-trips to the stored lists, through the foot boundary', () => {
  const out = layoutNav([{ k: '/a' }, { k: '/b' }, { k: '/c' }, {}], keyOfE, { order: ['/a', '---', '/b'], footer: ['/c'] });
  const ids = navEditIds(out);
  assert.deepEqual(ids, ['/a', '---0', '/b', NAV_FOOTER_MARK, '/c']);
  assert.deepEqual(navLayoutFromIds(moveKey(ids, '/a', '/c')), { order: ['---', '/b'], footer: ['/c', '/a'] });
  assert.deepEqual(navLayoutFromIds(moveKey(ids, NAV_FOOTER_MARK, '/a')), { order: [], footer: ['/a', '---', '/b', '/c'] });
});

test('a page of a plugin switched off keeps its place across a change made meanwhile', () => {
  const previous = { order: ['/a', '/growth', '/b', '---', '/c'], footer: ['/x', '/d'] };
  const next = { order: ['/b', '/a', '---', '/c'], footer: ['/d'] };
  const out = keepAbsentPaths(previous, next, new Set(['/a', '/b', '/c', '/d']));
  assert.deepEqual(out, { order: ['/b', '/a', '/growth', '---', '/c'], footer: ['/x', '/d'] });
  // Back on: it shows at that place.
  const shown = layoutNav([{ k: '/a' }, { k: '/b' }, { k: '/c' }, { k: '/d' }, { k: '/growth' }], keyOfE, out);
  assert.deepEqual(shape(shown.main), ['/b', '/a', '/growth', '|', '/c']);
});

test('a page absent from a row from before the foot is kept too', () => {
  const out = keepAbsentPaths({ order: ['/growth', '/a'], footer: null }, { order: ['/a'], footer: [] }, new Set(['/a']));
  assert.deepEqual(out, { order: ['/growth', '/a'], footer: [] });
});

test('a proposal replaces the lists it gives; the other keeps what the menu shows, minus the pages moved', () => {
  const keys = ['/a', '/b', NAV_SEPARATOR, '/c', '/d'];
  // A row from before the foot: read as shown, the product's divider included.
  assert.deepEqual(proposedNavLayout({ order: [], footer: null }, keys, { footer: ['/c'] }), { order: ['/a', '/b', '---', '/d'], footer: ['/c'] });
  assert.deepEqual(proposedNavLayout({ order: ['/d', '/a', '---', '/b', '/c'], footer: [] }, keys, { order: ['/c', '---', '/a'] }), { order: ['/c', '---', '/a'], footer: [] });
  // A page of a plugin switched off keeps its place.
  assert.deepEqual(proposedNavLayout({ order: ['/a', '/off', '/b'], footer: ['/c'] }, keys, { footer: ['/a', '/c'] }), { order: ['/off', '/b', '/d'], footer: ['/a', '/c'] });
});
