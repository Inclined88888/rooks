import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASCADE, MAX_WINDOWS, NOT_A_PLACE, OVERLAY_PARAMS, WindowLayoutKeeper, cascadeFrom, layoutRoute, placeSavedWindows, readWindowLayout,
  routeOfUrl, writeWindowLayout,
  type DisplayArea, type SavedWindow, type WindowLayout,
} from './window-layout.js';
import { DEFAULT_SIZE, writeWindowState } from './window-state.js';

const home = (): string => mkdtempSync(join(tmpdir(), 'timon-window-layout-'));
const display = (id: number, x: number, width = 1920, height = 1080): DisplayArea => ({
  id, bounds: { x, y: 0, width, height }, workArea: { x, y: 0, width, height: height - 40 },
});
const left = display(1, 0);
const middle = display(2, 1920);
const right = display(3, 3840);
const saved = (over: Partial<SavedWindow> = {}): SavedWindow => ({
  bounds: { x: 100, y: 80, width: 1000, height: 700 }, maximized: false, fullScreen: false, displayId: 1, machineId: null, route: null, ...over,
});

test('V3: three windows on three displays come back each on its own, with its machine', () => {
  const layout = [
    saved({ machineId: 'local' }),
    saved({ bounds: { x: 2000, y: 50, width: 1200, height: 800 }, displayId: 2, machineId: 'vps', maximized: true }),
    saved({ bounds: { x: 3900, y: 60, width: 1000, height: 900 }, displayId: 3, machineId: 'nas' }),
  ];
  assert.deepEqual(placeSavedWindows(layout, [left, middle, right]), [
    { machineId: 'local', route: null, placement: { x: 100, y: 80, width: 1000, height: 700, maximized: false, fullScreen: false } },
    { machineId: 'vps', route: null, placement: { x: 2000, y: 50, width: 1200, height: 800, maximized: true, fullScreen: false } },
    { machineId: 'nas', route: null, placement: { x: 3900, y: 60, width: 1000, height: 900, maximized: false, fullScreen: false } },
  ]);
});

test('V3: a window whose display is gone comes back inside the primary display, never off screen', () => {
  const layout = [
    saved({ bounds: { x: 3900, y: 60, width: 1000, height: 900 }, displayId: 3, machineId: 'nas' }),
    saved({ bounds: { x: 4100, y: 60, width: 1000, height: 900 }, displayId: 3, machineId: 'vps' }),
  ];
  const [first, second] = placeSavedWindows(layout, [left]);
  assert.deepEqual(first, { machineId: 'nas', route: null, placement: { x: 460, y: 70, width: 1000, height: 900, maximized: false, fullScreen: false } });
  // Two displaced windows never land exactly on top of each other.
  assert.equal(second!.placement.x, 460 + CASCADE);
  for (const { placement } of [first!, second!]) {
    assert.ok(placement.x! >= 0 && placement.x! + placement.width <= 1920);
    assert.ok(placement.y! >= 0 && placement.y! + placement.height <= 1040);
  }
});

test('V3: a display that moved (same id, new coordinates) gets its window back', () => {
  // The middle screen is now left of the primary one.
  const moved = display(2, -1920);
  const [w] = placeSavedWindows([saved({ bounds: { x: 2000, y: 50, width: 1200, height: 800 }, displayId: 2 })], [left, moved]);
  assert.ok(w!.placement.x! >= -1920 && w!.placement.x! + w!.placement.width <= 0, 'on the moved display');
});

test('V3: a window larger than its display shrinks to the work area (DPI or resolution change)', () => {
  const small = display(1, 0, 1280, 720);
  const [w] = placeSavedWindows([saved({ bounds: { x: 0, y: 0, width: 1800, height: 1000 } })], [small]);
  assert.deepEqual(w!.placement, { x: 0, y: 0, width: 1280, height: 680, maximized: false, fullScreen: false });
});

test('V3: without any display the OS places the windows', () => {
  const [w] = placeSavedWindows([saved()], []);
  assert.deepEqual(w!.placement, { width: 1000, height: 700, maximized: false, fullScreen: false });
});

test('V3: a new window cascades from the one in front and stays on its display', () => {
  assert.deepEqual(cascadeFrom({ x: 100, y: 80, width: 1000, height: 700 }, [left]),
    { x: 100 + CASCADE, y: 80 + CASCADE, width: 1000, height: 700, maximized: false, fullScreen: false });
  // At the bottom-right corner it starts again at the top-left of the work area.
  assert.deepEqual(cascadeFrom({ x: 900, y: 330, width: 1000, height: 700 }, [left]),
    { x: 0, y: 0, width: 1000, height: 700, maximized: false, fullScreen: false });
  assert.deepEqual(cascadeFrom({ x: 2000, y: 50, width: 1000, height: 700 }, [left, middle]).x, 2000 + CASCADE);
  assert.deepEqual(cascadeFrom(null, [left]), { ...DEFAULT_SIZE, maximized: false, fullScreen: false });
});

test('V3: the layout round-trips, and a corrupt entry is dropped rather than trusted', () => {
  const h = home();
  const layout: WindowLayout = { windows: [saved({ machineId: 'vps' }), saved({ displayId: null })], lastMachine: 'vps' };
  writeWindowLayout(h, layout);
  assert.deepEqual(readWindowLayout(h), layout);
  writeFileSync(join(h, 'window-layout.json'), JSON.stringify({
    windows: [saved({ machineId: 'https://evil.example' }), { bounds: { x: 0, y: 0, width: 10, height: 10 } }, 'junk'],
    lastMachine: '../x',
  }));
  assert.deepEqual(readWindowLayout(h), { windows: [saved({ machineId: null })], lastMachine: null });
  writeFileSync(join(h, 'window-layout.json'), JSON.stringify({ windows: Array.from({ length: 50 }, () => saved()) }));
  assert.equal(readWindowLayout(h).windows.length, MAX_WINDOWS);
});

test('V3: the single window of an older version is read as a one-window layout', () => {
  const h = home();
  assert.deepEqual(readWindowLayout(h), { windows: [], lastMachine: null });
  writeWindowState(h, { bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true, fullScreen: false });
  assert.deepEqual(readWindowLayout(h), {
    windows: [{ bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true, fullScreen: false, displayId: null, machineId: null, route: null }],
    lastMachine: null,
  });
});

function keeper(open: SavedWindow[], initial: WindowLayout = { windows: [], lastMachine: null }) {
  const writes: WindowLayout[] = [];
  const timers: (() => void)[] = [];
  const k = new WindowLayoutKeeper(initial, {
    snapshot: () => [...open],
    write: (layout) => writes.push(layout),
    timers: { set: (fn) => { timers.push(fn); return timers.length; }, clear: () => {} },
  });
  return { k, writes, timers, open };
}

test('V3: moves are saved once the drag settles', () => {
  const { k, writes, timers } = keeper([saved()]);
  k.changed(); k.changed();
  assert.equal(writes.length, 0);
  timers.at(-1)!();
  assert.deepEqual(writes, [{ windows: [saved()], lastMachine: null }]);
});

test('V3: closing windows one by one keeps the last one for the next opening', () => {
  const a = saved({ machineId: 'vps' }); const b = saved({ machineId: 'nas' });
  const { k, writes, open } = keeper([a, b]);
  k.closing(b); open.splice(1, 1); k.save();
  assert.deepEqual(writes.at(-1)!.windows, [a]);
  k.closing(a); open.splice(0, 1); k.save();
  assert.deepEqual(writes.at(-1)!.windows, [a]);
});

test('V3: quitting keeps every window open at that moment, whatever closes afterwards', () => {
  const a = saved({ machineId: 'vps' }); const b = saved({ machineId: 'nas' });
  const { k, writes, open } = keeper([a, b]);
  k.freeze();
  assert.deepEqual(writes.at(-1)!.windows, [a, b]);
  k.closing(b); open.splice(1, 1); k.save(); k.changed();
  k.closing(a); open.splice(0, 1); k.save();
  assert.equal(writes.length, 1, 'nothing written after the freeze');
});

test('TODO #758: a quit called off follows the windows again and saves those still open', () => {
  const a = saved({ machineId: 'vps' }); const b = saved({ machineId: 'nas' });
  const { k, writes, timers, open } = keeper([a, b]);
  k.freeze();
  // The quit closed a, then the user stayed on b.
  k.closing(a); open.splice(0, 1); k.save();
  k.thaw();
  assert.deepEqual(writes.at(-1)!.windows, [b], 'the window the quit closed is gone');
  k.changed();
  timers.at(-1)!();
  assert.equal(writes.length, 3, 'moves are saved again');
  k.thaw();
  assert.equal(writes.length, 3, 'thawing a keeper that was not frozen writes nothing');
});

test('V3: the machine chosen last is remembered for the next new window', () => {
  const { k, timers, writes } = keeper([saved()]);
  k.machineChosen('vps');
  timers.at(-1)!();
  assert.equal(writes.at(-1)!.lastMachine, 'vps');
  k.machineChosen('not an id');
  assert.equal(k.current.lastMachine, null);
});

test('V3: before any window opens, the layout read at launch is not wiped', () => {
  const initial = { windows: [saved({ machineId: 'vps' })], lastMachine: 'vps' };
  const { k, writes } = keeper([], initial);
  k.save();
  assert.deepEqual(writes.at(-1), initial);
  assert.deepEqual(JSON.parse(JSON.stringify(k.current)), initial);
});

test('TODO #760: each window reopens on the page it showed', () => {
  const h = home();
  const layout: WindowLayout = {
    windows: [saved({ route: '/chat?mission=m1' }), saved({ machineId: 'vps', route: '/kanban' })],
    lastMachine: 'vps',
  };
  writeWindowLayout(h, layout);
  assert.deepEqual(readWindowLayout(h), layout);
  assert.deepEqual(placeSavedWindows(readWindowLayout(h).windows, [left]).map((w) => [w.machineId, w.route]),
    [[null, '/chat?mission=m1'], ['vps', '/kanban']]);
});

test('TODO #760: a layout written before routes, or a route that is not a page, reopens the window on the home page', () => {
  const h = home();
  const { route: _omitted, ...older } = saved({ machineId: 'vps' });
  writeFileSync(join(h, 'window-layout.json'), JSON.stringify({
    windows: [older, ...['https://evil.example/', '//evil.example', '/\\evil.example', '/\t/evil', '/setup', '/login?next=/', '/api/ui/tasks', 42]
      .map((route) => ({ ...saved(), route }))],
  }));
  const read = readWindowLayout(h).windows;
  assert.equal(read.length, 9, 'the windows are kept, only their page is dropped');
  assert.deepEqual(read.map((w) => w.route), Array(9).fill(null));
  assert.equal(read[0]!.machineId, 'vps');
});

test('TODO #760: the page kept is path and query, without the Settings overlay or the fragment', () => {
  assert.equal(layoutRoute('/kanban?settings=general&project=timon#card'), '/kanban?project=timon');
  assert.equal(layoutRoute('/'), '/');
  assert.equal(layoutRoute('x'.repeat(10)), null);
  assert.equal(layoutRoute(`/${'a'.repeat(2048)}`), null);
  assert.equal(routeOfUrl('http://127.0.0.1:3101/missions?selected=m2#x', 'http://127.0.0.1:3101'), '/missions?selected=m2');
  assert.equal(routeOfUrl('http://127.0.0.1:3101/setup', 'http://127.0.0.1:3101'), null);
  assert.equal(routeOfUrl('http://127.0.0.1:9999/kanban', 'http://127.0.0.1:3101'), null, 'another origin');
  assert.equal(routeOfUrl('data:text/html,waiting', 'http://127.0.0.1:3101'), null, 'the waiting page');
  assert.equal(routeOfUrl('', 'http://127.0.0.1:3101'), null);
});

test('TODO #760: the pages the shell will not reopen are those the app will not remember', () => {
  const source = readFileSync(fileURLToPath(new URL('../../app/src/lib/machines/last-route.ts', import.meta.url)), 'utf8');
  const list = (name: string): string[] => {
    const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
    assert.ok(match, name);
    return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
  };
  assert.deepEqual(NOT_A_PLACE, list('NOT_A_PLACE'));
  assert.deepEqual(OVERLAY_PARAMS, list('OVERLAY_PARAMS'));
});
