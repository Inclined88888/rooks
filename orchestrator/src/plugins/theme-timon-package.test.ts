/**
 * The built-in Timon theme (`plugins/theme-timon`) passes the daemon's own
 * manifest check: a theme, client half only, in the `theme` slot. Its id is
 * the default theme of an account without a row (`DEFAULT_USER_PREFS`).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-theme-timon-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest } = await import('./manifest.js');
const { DEFAULT_USER_PREFS } = await import('../db.js');

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'plugins', 'theme-timon', 'package.json'), 'utf8')) as unknown;

test('the Timon theme package is a valid theme manifest', () => {
  const result = readManifest(pkg);
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.equal(result.manifest.id, 'theme-timon');
  assert.deepEqual(result.manifest.kind, ['theme']);
  assert.deepEqual(result.manifest.client?.slots, ['theme']);
  assert.deepEqual(result.manifest.permissions, [], 'a palette asks for nothing');
});

test('its id is the default theme of a new account', () => {
  assert.equal(DEFAULT_USER_PREFS.theme, 'theme-timon');
});
