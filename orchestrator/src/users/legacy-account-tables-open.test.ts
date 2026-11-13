/**
 * The move happens when the daemon opens an existing database: an install with
 * several accounts updates, its account tables land in the home's file before
 * they leave the schema, and the account provider reads them back (TODO #906).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { legacyRows, legacySchema } from '../../tests/helpers/legacy-accounts.js';

const home = mkdtempSync(join(tmpdir(), 'rooks-legacy-open-'));
process.env.ROOKS_HOME = home;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
{
  const before = new Database(join(home, 'rooks.db'));
  legacySchema(before);
  legacyRows(before);
  before.close();
}

const { db, dbApi, LEGACY_ACCOUNT_TABLES } = await import('../db.js');
const { LEGACY_ACCOUNT_TABLES_FILE } = await import('../paths.js');

test('opening an existing database moves its account tables to the owner-only file', () => {
  assert.equal(LEGACY_ACCOUNT_TABLES_FILE, join(home, 'legacy-account-tables.json'));
  assert.ok(existsSync(LEGACY_ACCOUNT_TABLES_FILE));
  if (process.platform !== 'win32') assert.equal(statSync(LEGACY_ACCOUNT_TABLES_FILE).mode & 0o077, 0);
  const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name));
  for (const table of LEGACY_ACCOUNT_TABLES) assert.equal(tables.has(table), false, `${table} left the schema`);
});

test('the accounts are untouched, and the rows come back through readLegacyAccountTable', () => {
  assert.deepEqual(dbApi.listUsers().map((u) => u.email).sort(), ['ada@example.com', 'boss@example.com']);
  assert.deepEqual(dbApi.readLegacyAccountTable('roles').map((r) => r.id), ['r-reader']);
  assert.deepEqual(dbApi.readLegacyAccountTable('user_groups'), [{ user_id: 'ada', group_id: 'g-team' }]);
  assert.equal(dbApi.readLegacyAccountTable('invitations').length, 1);
});
