import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowRegistry } from './window-registry.js';
import { ViewPool } from './view-pool.js';

type Fake = { name: string };
const origin = 'http://127.0.0.1:3110';
const fill = () => {
  const registry = new WindowRegistry<Fake, string>();
  const a = { name: 'a' }; const b = { name: 'b' }; const c = { name: 'c' };
  for (const [id, window, machineId] of [[11, a, null], [12, b, 'vps'], [13, c, 'nas']] as const) {
    const pages = new ViewPool<string>();
    pages.enter(machineId, () => ({ contentsId: id * 10, machineId, view: `page ${id}` }));
    registry.add({ id, window, origin, machineId, pages, closing: false, route: null });
  }
  return { registry, a, b, c };
};

test('V3: windows are kept oldest first, found by webContents id or by window', () => {
  const { registry, b } = fill();
  assert.deepEqual(registry.list().map((r) => r.id), [11, 12, 13]);
  assert.equal(registry.get(12)?.machineId, 'vps');
  assert.equal(registry.find(b)?.id, 12);
  assert.equal(registry.get(99), null);
  assert.equal(registry.find({ name: 'b' }), null);
  assert.equal(registry.size, 3);
});

test('V3: the oldest window is the primary one, and the next takes over when it closes', () => {
  const { registry } = fill();
  assert.equal(registry.primary()?.id, 11);
  assert.equal(registry.isPrimary(12), false);
  registry.remove(11);
  assert.equal(registry.primary()?.id, 12);
  assert.equal(registry.isPrimary(12), true);
  registry.remove(12); registry.remove(13);
  assert.equal(registry.primary(), null);
});

test('V3: changing one window\'s machine leaves the others alone', () => {
  const { registry } = fill();
  assert.equal(registry.setMachine(12, 'nas'), true);
  assert.equal(registry.setMachine(12, 'nas'), false, 'same machine: nothing changed');
  assert.equal(registry.setMachine(99, 'nas'), false, 'unknown window');
  assert.deepEqual(registry.list().map((r) => r.machineId), [null, 'nas', 'nas']);
});

test('V4: a request is pinned by its PAGE, which may drive another machine than the one on screen', () => {
  const { registry } = fill();
  const vps = registry.get(12)!;
  vps.pages.enter('nas', () => ({ contentsId: 121, machineId: 'nas', view: 'nas page' }));
  registry.setMachine(12, 'nas');
  assert.deepEqual(registry.pinnedFor(120), { origin, machineId: 'vps' }, 'the hidden page still talks to its own machine');
  assert.deepEqual(registry.pinnedFor(121), { origin, machineId: 'nas' });
  assert.equal(registry.pageOf(121)?.record, vps);
  assert.equal(registry.pinnedFor(12), null, 'the window\'s own webContents is no page');
  assert.equal(registry.pinnedFor(999), null);
  vps.pages.forget(120);
  assert.equal(registry.pinnedFor(120), null, 'a destroyed page is no longer found');
});
