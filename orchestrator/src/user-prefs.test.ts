/**
 * T.2 — user_prefs: no row is product defaults; two accounts keep two
 * schemes; an empty user_id is refused (prefs have no machine template).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-user-prefs-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { dbApi, DEFAULT_USER_PREFS } = await import('./db.js');

test('no row returns product defaults without inserting', () => {
  const prefs = dbApi.userPrefsGet('user-nobody');
  assert.deepEqual(prefs, DEFAULT_USER_PREFS);
  assert.deepEqual(dbApi.userPrefsGet(null), DEFAULT_USER_PREFS);
  assert.deepEqual(dbApi.userPrefsGet(''), DEFAULT_USER_PREFS);
  assert.deepEqual(dbApi.userPrefsGet(undefined), DEFAULT_USER_PREFS);
});

test('two users keep two schemes; theme and layout stay product defaults', () => {
  const ada = dbApi.userPrefsSet('user-ada', { scheme: 'light' });
  assert.equal(ada.scheme, 'light');
  assert.equal(ada.theme, 'theme-rooks', 'an account made today wears the Rooks theme');
  assert.equal(ada.layout, '@rooks/ui-layout');

  dbApi.userPrefsSet('user-bob', { scheme: 'dark' });
  assert.equal(dbApi.userPrefsGet('user-ada')?.scheme, 'light');
  assert.equal(dbApi.userPrefsGet('user-bob')?.scheme, 'dark');
  assert.deepEqual(dbApi.userPrefsGet('user-carol'), DEFAULT_USER_PREFS);
});

test('partial merge writes theme without touching scheme', () => {
  dbApi.userPrefsSet('user-ada-theme', { scheme: 'light' });
  dbApi.userPrefsSet('user-ada-theme', { theme: 'plugin-theme' });
  const row = dbApi.userPrefsGet('user-ada-theme');
  assert.equal(row.theme, 'plugin-theme');
  assert.equal(row.scheme, 'light');
  assert.equal(row.layout, '@rooks/ui-layout');
});

test('an empty user_id is refused on write', () => {
  assert.throws(
    () => dbApi.userPrefsSet('', { scheme: 'light' }),
    /must not be empty/,
  );
});
