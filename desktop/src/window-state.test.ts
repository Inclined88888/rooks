import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SIZE, placementFor, readWindowState, trackWindowState, writeWindowState,
  type Rect, type TrackedWindow, type WindowState,
} from './window-state.js';

const home = (): string => mkdtempSync(join(tmpdir(), 'timon-window-state-'));
const screen: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const saved = (over: Partial<WindowState> = {}): WindowState => ({
  bounds: { x: 100, y: 80, width: 1000, height: 700 }, maximized: false, fullScreen: false, ...over,
});

test('SUG-0034: with nothing remembered the window opens at the default size', () => {
  assert.deepEqual(readWindowState(home()), null);
  assert.deepEqual(placementFor(null, [screen]), { ...DEFAULT_SIZE, maximized: false, fullScreen: false });
});

test('SUG-0034: a saved state round-trips through the file', () => {
  const h = home();
  writeWindowState(h, saved({ maximized: true }));
  assert.deepEqual(readWindowState(h), saved({ maximized: true }));
});

test('SUG-0034: a corrupt or implausible file is ignored', () => {
  const h = home();
  writeFileSync(join(h, 'window-state.json'), '{broken');
  assert.equal(readWindowState(h), null);
  writeFileSync(join(h, 'window-state.json'), JSON.stringify({ bounds: { x: 0, y: 0, width: 10, height: 10 } }));
  assert.equal(readWindowState(h), null);
  writeFileSync(join(h, 'window-state.json'), JSON.stringify({ bounds: { x: 'a', y: 0, width: 900, height: 700 } }));
  assert.equal(readWindowState(h), null);
});

test('SUG-0034: the saved position is reused when the window is on a display', () => {
  assert.deepEqual(placementFor(saved({ fullScreen: true }), [screen]), {
    x: 100, y: 80, width: 1000, height: 700, maximized: false, fullScreen: true,
  });
});

test('SUG-0034: a window left on an unplugged display keeps its size but is re-placed by the OS', () => {
  const second: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };
  const state = saved({ bounds: { x: 2300, y: 100, width: 1000, height: 700 } });
  assert.deepEqual(placementFor(state, [screen]), { width: 1000, height: 700, maximized: false, fullScreen: false });
  assert.equal(placementFor(state, [screen, second]).x, 2300);
});

test('SUG-0034: a window larger than every display is capped and re-placed', () => {
  const small: Rect = { x: 0, y: 0, width: 1280, height: 720 };
  const placed = placementFor(saved({ bounds: { x: 0, y: 0, width: 2500, height: 1300 } }), [small]);
  assert.deepEqual([placed.width, placed.height, placed.x], [1280, 720, undefined]);
});

function fakeWindow(destroyed = false): TrackedWindow & { fire(e: 'resize' | 'move' | 'close'): void } {
  const listeners = new Map<string, () => void>();
  return {
    getNormalBounds: () => saved().bounds, isMaximized: () => true, isFullScreen: () => false,
    isDestroyed: () => destroyed,
    on: (e, l) => { listeners.set(e, l); },
    fire: (e) => listeners.get(e)?.(),
  };
}

test('SUG-0034: resizes are debounced and a close flushes immediately', () => {
  const h = home();
  const w = fakeWindow();
  const queue: Array<() => void> = [];
  trackWindowState(w, h, { set: (fn) => { queue.push(fn); return queue.length - 1; }, clear: () => {} }, 500);
  w.fire('resize'); w.fire('move');
  assert.equal(existsSync(join(h, 'window-state.json')), false);
  w.fire('close');
  assert.deepEqual(readWindowState(h), saved({ maximized: true }));
  assert.deepEqual(readdirSync(h), ['window-state.json']);
});

test('SUG-0034: a destroyed window writes nothing', () => {
  const h = home();
  const w = fakeWindow(true);
  trackWindowState(w, h);
  w.fire('close');
  assert.equal(readWindowState(h), null);
});
