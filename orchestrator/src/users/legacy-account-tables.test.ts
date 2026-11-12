/**
 * The account tables leave the core's schema without losing a row (TODO #906,
 * decision 5): written to an owner-only file, then dropped, once.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  LEGACY_ACCOUNT_TABLES,
  legacyAccountTablesPresent,
  moveLegacyAccountTables,
  readLegacyAccountRows,
} from './legacy-account-tables.js';
import { DESTRUCTIVE_MIGRATIONS } from '../data-version.js';
import { legacyRows, legacySchema } from '../../tests/helpers/legacy-accounts.js';

const tableNames = (db: Database.Database): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);

function scratch(): { db: Database.Database; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-legacy-accounts-'));
  return { db: new Database(join(dir, 'rooks.db')), file: join(dir, 'legacy-account-tables.json') };
}

test('a database with the seven tables filled: written to the file, then dropped, users kept', () => {
  const { db, file } = scratch();
  legacySchema(db);
  legacyRows(db);
  const outcome = moveLegacyAccountTables(db, file, 1234);
  assert.equal(outcome.dropped, true);
  assert.deepEqual([...outcome.exported].sort(), [...LEGACY_ACCOUNT_TABLES].sort());

  for (const table of LEGACY_ACCOUNT_TABLES) assert.ok(!tableNames(db).includes(table), `${table} is dropped`);
  const columns = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(!columns.includes('role_id'), 'users.role_id is dropped');
  assert.deepEqual((db.prepare(`SELECT id FROM users ORDER BY id`).all() as { id: string }[]).map((u) => u.id), ['ada', 'boss']);
  // Without its reference to `roles`, an account can still be added.
  db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('eve', 'eve@example.com', 'Eve', 'h', 5)`).run();
  assert.equal(legacyAccountTablesPresent(db), false);

  assert.ok(existsSync(file));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0, 'readable by the owner only');
  assert.deepEqual(readLegacyAccountRows(file, 'roles'), [{ id: 'r-reader', name: 'Reader', description: 'reads', created_at: 3 }]);
  assert.deepEqual(readLegacyAccountRows(file, 'role_permissions').map((r) => r.permission).sort(), ['kanban:read', 'missions:read']);
  assert.deepEqual(readLegacyAccountRows(file, 'user_groups'), [{ user_id: 'ada', group_id: 'g-team' }]);
  assert.deepEqual(readLegacyAccountRows(file, 'group_roles'), [{ group_id: 'g-team', role_id: 'r-reader' }]);
  assert.deepEqual(readLegacyAccountRows(file, 'user_roles'), [{ user_id: 'ada', role_id: 'r-reader' }], 'role_id and user_roles agree: one row');
  assert.equal(readLegacyAccountRows(file, 'invitations')[0]?.group_ids, '["g-team"]');
  assert.equal(readLegacyAccountRows(file, 'groups').length, 1);
  db.close();
});

test('the second open moves nothing and leaves the file as it was', () => {
  const { db, file } = scratch();
  legacySchema(db);
  legacyRows(db);
  moveLegacyAccountTables(db, file, 1);
  const before = readFileSync(file, 'utf8');
  const again = moveLegacyAccountTables(db, file, 2);
  assert.deepEqual(again, { exported: [], rows: 0, dropped: false });
  assert.equal(readFileSync(file, 'utf8'), before);
  db.close();
});

test('a new database: no table, no file, and readLegacy answers nothing', () => {
  const { db, file } = scratch();
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL)`);
  assert.deepEqual(moveLegacyAccountTables(db, file), { exported: [], rows: 0, dropped: false });
  assert.equal(existsSync(file), false);
  for (const table of LEGACY_ACCOUNT_TABLES) assert.deepEqual(readLegacyAccountRows(file, table), []);
  assert.throws(() => readLegacyAccountRows(file, 'users' as never), /not a legacy account table/);
  db.close();
});

test('tables recreated by an older version and moved again: both copies are kept', () => {
  const { db, file } = scratch();
  legacySchema(db);
  legacyRows(db);
  moveLegacyAccountTables(db, file, 1);
  db.exec(`
    CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL);
    INSERT INTO roles VALUES ('r-late', 'Late', NULL, 9);
  `);
  moveLegacyAccountTables(db, file, 2);
  assert.deepEqual(readLegacyAccountRows(file, 'roles').map((r) => r.id).sort(), ['r-late', 'r-reader']);
  assert.equal(readLegacyAccountRows(file, 'user_groups').length, 1, 'what the second move did not see stays');
  db.close();
});

test('a file that cannot be written drops nothing: the tables wait for the next open', () => {
  const { db, file } = scratch();
  legacySchema(db);
  legacyRows(db);
  const unwritable = join(file, 'no-such-dir', 'legacy-account-tables.json');
  const outcome = moveLegacyAccountTables(db, unwritable);
  assert.equal(outcome.dropped, false);
  assert.ok(tableNames(db).includes('roles'));
  assert.equal(legacyAccountTablesPresent(db), true);
  db.close();
});

test('a corrupt file is not overwritten, and the tables stay', () => {
  const { db, file } = scratch();
  legacySchema(db);
  legacyRows(db);
  writeFileSync(file, '{ not json');
  assert.equal(moveLegacyAccountTables(db, file).dropped, false);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  assert.ok(tableNames(db).includes('user_groups'));
  db.close();
});

test('the move is declared destructive, and applied once the tables are gone', () => {
  const migration = DESTRUCTIVE_MIGRATIONS.find((m) => m.id === 'account-tables-to-file');
  assert.ok(migration);
  assert.deepEqual([...migration.breaks].sort(), [...LEGACY_ACCOUNT_TABLES, 'users.role_id'].sort());
  const { db, file } = scratch();
  legacySchema(db);
  assert.equal(migration.applied(db), false);
  moveLegacyAccountTables(db, file);
  assert.equal(migration.applied(db), true);
  db.close();
});
