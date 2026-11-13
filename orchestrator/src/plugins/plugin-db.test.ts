import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPluginSql, migratePluginDb, openPluginDb, PLUGIN_DB_MAX_BYTES, pluginDbFile, pluginSqlFacade,
  readMigrations, resolveMigrationsDir,
} from './plugin-db.js';

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-db-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-db-data-'));
  return openPluginDb(pluginDbFile(dir));
}

test('migrations are read in number order and must follow each other from 1', () => {
  const dir = migrationsDir({ '002-b.sql': 'CREATE TABLE b (x);', '001-a.sql': 'CREATE TABLE a (x);', 'README.md': 'ignored' });
  assert.deepEqual(readMigrations(dir).map((m) => m.name), ['001-a.sql', '002-b.sql']);
  assert.throws(() => readMigrations(migrationsDir({ '001-a.sql': 'SELECT 1;', '003-c.sql': 'SELECT 1;' })), /without gap or duplicate/);
  assert.throws(() => readMigrations(migrationsDir({ '1-a.sql': 'SELECT 1;', '01-b.sql': 'SELECT 1;' })), /without gap or duplicate/);
  assert.throws(() => readMigrations(migrationsDir({ 'a.sql': 'SELECT 1;' })), /NNN-name\.sql/);
  assert.throws(() => readMigrations(join(tmpdir(), 'no-such-migrations-folder')), /does not exist/);
});

test('a migration that opens another file is refused before it runs', () => {
  assert.throws(() => readMigrations(migrationsDir({ '001-a.sql': "ATTACH DATABASE '/tmp/x.db' AS other;" })), /ATTACH/);
  assert.throws(() => assertPluginSql('select load_extension(\'x\')'), /load_extension/);
  assert.throws(() => assertPluginSql('  '), /empty/);
});

test('the migrations folder must stay inside the package', () => {
  const pkg = mkdtempSync(join(tmpdir(), 'plugin-db-pkg-'));
  assert.equal(resolveMigrationsDir(pkg, 'migrations'), join(pkg, 'migrations'));
  assert.throws(() => resolveMigrationsDir(pkg, join('..', 'elsewhere')), /inside the package/);
  assert.throws(() => resolveMigrationsDir(pkg, join(pkg, 'migrations')), /folder of the package/);
});

test('migrations apply once, in order, and the version is kept in user_version', () => {
  const db = freshDb();
  const migs = readMigrations(migrationsDir({
    '001-roles.sql': 'CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
    '002-seed.sql': "INSERT INTO roles VALUES ('r1', 'Admin');",
  }));
  assert.equal(migratePluginDb(db, migs), 2);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  // A second boot applies nothing: the seed row is not inserted twice.
  migratePluginDb(db, migs);
  assert.equal((db.prepare('SELECT count(*) AS n FROM roles').get() as { n: number }).n, 1);
  db.close();
});

test('a failing migration rolls back entirely and keeps the previous version', () => {
  const db = freshDb();
  migratePluginDb(db, readMigrations(migrationsDir({ '001-a.sql': 'CREATE TABLE a (x);' })));
  const broken = readMigrations(migrationsDir({
    '001-a.sql': 'CREATE TABLE a (x);',
    '002-b.sql': 'CREATE TABLE b (x); INSERT INTO nowhere VALUES (1);',
  }));
  assert.throws(() => migratePluginDb(db, broken), /migration 002-b\.sql failed/);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get(), undefined, 'no half migration');
  db.close();
});

test('a database ahead of the shipped migrations is a downgrade, refused', () => {
  const db = freshDb();
  migratePluginDb(db, readMigrations(migrationsDir({ '001-a.sql': 'CREATE TABLE a (x);', '002-b.sql': 'CREATE TABLE b (x);' })));
  assert.throws(() => migratePluginDb(db, readMigrations(migrationsDir({ '001-a.sql': 'CREATE TABLE a (x);' }))), /downgrade is refused/);
  db.close();
});

test('the database has a size ceiling', () => {
  const db = freshDb();
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  assert.equal(Number(db.pragma('max_page_count', { simple: true })), Math.floor(PLUGIN_DB_MAX_BYTES / pageSize));
  db.close();
});

test('the facade runs statements and transactions, refuses ATTACH, and dies with the plugin', () => {
  const db = freshDb();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  let open = true;
  const facade = pluginSqlFacade(db, () => open);
  assert.deepEqual(facade.prepare('INSERT INTO t (v) VALUES (?)').run('a'), { changes: 1, lastInsertRowid: 1 });
  assert.deepEqual(facade.prepare('SELECT v FROM t WHERE id = ?').get(1), { v: 'a' });
  assert.throws(() => facade.transaction(() => {
    facade.prepare('INSERT INTO t (v) VALUES (?)').run('b');
    throw new Error('stop');
  }), /stop/);
  assert.equal(facade.prepare('SELECT count(*) AS n FROM t').all()[0]!.n, 1, 'the transaction rolled back');
  assert.throws(() => facade.prepare("ATTACH DATABASE ':memory:' AS x"), /ATTACH/);
  open = false;
  assert.throws(() => facade.prepare('SELECT 1'), /closed/);
  db.close();
});

test('a nested folder name in the data dir is the database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-db-path-'));
  mkdirSync(join(dir, 'sub'));
  assert.equal(pluginDbFile(join(dir, 'sub')), join(dir, 'sub', 'plugin.db'));
});
