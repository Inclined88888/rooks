/**
 * SUG-0006: after installing a prerequisite by hand, a reload of the setup
 * screen lost what the user had typed, and nothing re-read the machine when
 * they came back to the window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSetupDraft, loadSetupDraft, RETURN_REFRESH_MIN_MS, saveSetupDraft, SETUP_DRAFT_KEY, shouldRefreshOnReturn,
} from './setup-draft';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

test('the typed paths and the app choice come back after a reload', () => {
  const storage = memoryStorage();
  saveSetupDraft(storage, { binaries: { codex: 'C:\\Tools\\codex.exe', claude: '' }, appEnabled: true });
  assert.deepEqual(loadSetupDraft(storage), { binaries: { codex: 'C:\\Tools\\codex.exe' }, appEnabled: true });
});

test('an empty form leaves no draft behind, and a cleared one is gone', () => {
  const storage = memoryStorage();
  saveSetupDraft(storage, { binaries: { codex: '/opt/codex' }, appEnabled: false });
  assert.ok(storage.map.has(SETUP_DRAFT_KEY));
  saveSetupDraft(storage, { binaries: { codex: '  ' }, appEnabled: false });
  assert.equal(storage.map.has(SETUP_DRAFT_KEY), false);
  saveSetupDraft(storage, { binaries: {}, appEnabled: true });
  clearSetupDraft(storage);
  assert.equal(loadSetupDraft(storage), null);
});

test('a damaged or foreign draft restores nothing', () => {
  const storage = memoryStorage();
  storage.setItem(SETUP_DRAFT_KEY, '{not json');
  assert.equal(loadSetupDraft(storage), null);
  storage.setItem(SETUP_DRAFT_KEY, JSON.stringify({ binaries: { codex: 42, claude: ['x'] }, appEnabled: 'yes' }));
  assert.equal(loadSetupDraft(storage), null);
  storage.setItem(SETUP_DRAFT_KEY, JSON.stringify({ binaries: ['codex'], appEnabled: true }));
  assert.deepEqual(loadSetupDraft(storage), { binaries: {}, appEnabled: true });
});

test('no storage or a refusing one costs the draft, never the screen', () => {
  assert.equal(loadSetupDraft(null), null);
  const refusing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.doesNotThrow(() => saveSetupDraft(refusing, { binaries: { codex: '/x' }, appEnabled: false }));
  assert.doesNotThrow(() => clearSetupDraft(refusing));
  assert.equal(loadSetupDraft(refusing), null);
});

test('coming back to the window re-reads the machine once, never while acting', () => {
  const now = 100_000;
  assert.equal(shouldRefreshOnReturn({ visible: true, busy: false, lastRefreshAt: now - RETURN_REFRESH_MIN_MS, now }), true);
  // `focus` right after `visibilitychange`: one request, not two.
  assert.equal(shouldRefreshOnReturn({ visible: true, busy: false, lastRefreshAt: now - 10, now }), false);
  assert.equal(shouldRefreshOnReturn({ visible: false, busy: false, lastRefreshAt: 0, now }), false);
  assert.equal(shouldRefreshOnReturn({ visible: true, busy: true, lastRefreshAt: 0, now }), false);
});
