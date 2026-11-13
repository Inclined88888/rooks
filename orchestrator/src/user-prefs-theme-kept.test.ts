/**
 * The Rooks theme became the default in 0.1.7 without changing anyone's
 * screen: an account that existed before keeps the product theme (its row is
 * written when `theme_kept` appears), an account made afterwards gets Rooks.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const home = mkdtempSync(join(tmpdir(), 'rooks-theme-kept-'));
process.env.ROOKS_HOME = home;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

// A database as a 0.1.6 daemon left it: one account, one with its own row,
// and no `theme_kept` column yet.
{
  const old = new Database(join(home, 'rooks.db'));
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', is_superadmin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, theme TEXT NOT NULL, layout TEXT NOT NULL, scheme TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('old-ada', 'ada@example.com', 'Ada', 'x', 1);
    INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('old-bob', 'bob@example.com', 'Bob', 'x', 1);
    INSERT INTO user_prefs (user_id, theme, layout, scheme, updated_at) VALUES ('old-bob', 'plugin-nord', '@rooks/ui-layout', 'light', 1);
  `);
  old.close();
}

const { dbApi } = await import('./db.js');

test('an account that existed before 0.1.7 keeps the product theme', () => {
  assert.deepEqual(dbApi.userPrefsGet('old-ada'), { theme: '@rooks/ui-theme', layout: '@rooks/ui-layout', scheme: 'dark' });
});

test('an account that had chosen its theme keeps its choice untouched', () => {
  assert.deepEqual(dbApi.userPrefsGet('old-bob'), { theme: 'plugin-nord', layout: '@rooks/ui-layout', scheme: 'light' });
});

test('an account made afterwards has no row, so it wears the Rooks theme', () => {
  // The backfill ran once, with the column: a later account is never pinned.
  assert.equal(dbApi.userPrefsGet('new-carol').theme, 'theme-rooks');
  dbApi.userPrefsSet('new-carol', { scheme: 'light' });
  assert.equal(dbApi.userPrefsGet('new-carol').theme, 'theme-rooks', 'a row written later starts from the new default');
});
