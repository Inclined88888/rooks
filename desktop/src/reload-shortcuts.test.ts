import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reloadShortcut, type ReloadKeyInput } from './reload-shortcuts.js';

const key = (k: string, mods: Partial<ReloadKeyInput> = {}): ReloadKeyInput => ({
  type: 'keyDown', key: k, control: false, meta: false, shift: false, alt: false, ...mods,
});

test('Ctrl+R reloads and Ctrl+Shift+R reloads past the cache, on Linux and Windows', () => {
  for (const platform of ['linux', 'win32'] as const) {
    assert.equal(reloadShortcut(key('r', { control: true }), platform), 'reload');
    assert.equal(reloadShortcut(key('R', { control: true, shift: true }), platform), 'force');
    assert.equal(reloadShortcut(key('r', { meta: true }), platform), null);
  }
});

test('macOS takes Cmd, not Ctrl', () => {
  assert.equal(reloadShortcut(key('r', { meta: true }), 'darwin'), 'reload');
  assert.equal(reloadShortcut(key('R', { meta: true, shift: true }), 'darwin'), 'force');
  assert.equal(reloadShortcut(key('r', { control: true }), 'darwin'), null);
});

test('F5 reloads, Shift+F5 and Ctrl+F5 force', () => {
  assert.equal(reloadShortcut(key('F5'), 'linux'), 'reload');
  assert.equal(reloadShortcut(key('F5', { shift: true }), 'linux'), 'force');
  assert.equal(reloadShortcut(key('F5', { control: true }), 'win32'), 'force');
});

test('a plain r typed in a field, a key release or an Alt chord is left to the page', () => {
  assert.equal(reloadShortcut(key('r'), 'linux'), null);
  assert.equal(reloadShortcut({ ...key('r', { control: true }), type: 'keyUp' }, 'linux'), null);
  assert.equal(reloadShortcut(key('r', { control: true, alt: true }), 'linux'), null);
});
