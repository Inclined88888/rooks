/**
 * The notice of a CLI that never started is the ONLY text the mission carries
 * (cf. `orchestrator/src/spawn-failed-visible.test.ts`). It must therefore name
 * the backend, the binary looked for, and say what to do — without ever falling
 * back to a raw i18n key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnFailureNotice } from './spawn-failure-notice';
import { setLocale } from './i18n';
import './i18n-test-locales';

test('binary not found: the notice names the backend, the binary and the gesture', () => {
  setLocale('en');
  const notice = spawnFailureNotice({ backend: 'claude', binary: 'claude', cause: 'missing' });
  assert.match(notice, /claude/);
  assert.match(notice, /not found/i);
  assert.match(notice, /host\.binaries\.claude/);
  assert.doesNotMatch(notice, /chatPage\./, 'unresolved i18n key');
});

test('binary not executable: a gesture other than "install it"', () => {
  setLocale('en');
  const notice = spawnFailureNotice({ backend: 'codex', binary: 'codex', cause: 'not_executable' });
  assert.match(notice, /not executable/i);
  assert.doesNotMatch(notice, /Install it/);
});

test('unknown cause or damaged payload: a readable sentence, never "undefined"', () => {
  setLocale('en');
  const notice = spawnFailureNotice({});
  assert.doesNotMatch(notice, /undefined/);
  assert.doesNotMatch(notice, /chatPage\./);
});

test('the notice follows the locale', () => {
  setLocale('fr');
  try {
    const notice = spawnFailureNotice({ backend: 'grok', binary: 'grok', cause: 'missing' });
    assert.match(notice, /introuvable/);
  } finally {
    setLocale('en');
  }
});
