/** The outcome columns of `project_todo` move to the plugin table, then go;
 *  the table of the plugin's former name is renamed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateTodoOutcomeColumns, TODO_OUTCOME_DDL } from './todo-outcome-migration.js';

function oldSchema(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE project_todo (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    updated_at INTEGER NOT NULL, resolution TEXT, public_note TEXT, duplicate_of TEXT)`);
  const insert = db.prepare(`INSERT INTO project_todo (text, updated_at, resolution, public_note, duplicate_of) VALUES (?, ?, ?, ?, ?)`);
  insert.run('TIM-0001 · fixed', 10, 'fixed', 'Thanks!', null);
  insert.run('SUG-0002 · dup', 20, 'duplicate', null, 'SUG-0001');
  insert.run('note only', 30, null, 'a public note', null);
  insert.run('untouched', 40, null, null, null);
  return db;
}

const columns = (db: Database.Database) =>
  (db.prepare(`PRAGMA table_info(project_todo)`).all() as { name: string }[]).map((c) => c.name);

test('every outcome is copied, then the three columns are dropped', () => {
  const db = oldSchema();
  migrateTodoOutcomeColumns(db);
  assert.deepEqual(columns(db), ['id', 'text', 'status', 'updated_at']);
  assert.deepEqual(db.prepare(`SELECT * FROM todo_outcome ORDER BY todo_id`).all(), [
    { todo_id: 1, resolution: 'fixed', public_note: 'Thanks!', duplicate_of: null, updated_at: 10 },
    { todo_id: 2, resolution: 'duplicate', public_note: null, duplicate_of: 'SUG-0001', updated_at: 20 },
    { todo_id: 3, resolution: null, public_note: 'a public note', duplicate_of: null, updated_at: 30 },
  ]);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM project_todo`).get() as { n: number }).n, 4);
});

test('a second boot does nothing', () => {
  const db = oldSchema();
  migrateTodoOutcomeColumns(db);
  migrateTodoOutcomeColumns(db);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM todo_outcome`).get() as { n: number }).n, 3);
});

test('an install that never had the columns gets no table from the core', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE project_todo (id INTEGER PRIMARY KEY, text TEXT, updated_at INTEGER)`);
  migrateTodoOutcomeColumns(db);
  assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'todo_outcome'`).get(), undefined);
});

test('an outcome already in the plugin table wins over the column', () => {
  const db = oldSchema();
  db.exec(`CREATE TABLE todo_outcome (
    todo_id INTEGER PRIMARY KEY REFERENCES project_todo(id) ON DELETE CASCADE,
    resolution TEXT, public_note TEXT, duplicate_of TEXT, updated_at INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO todo_outcome VALUES (1, 'declined', NULL, NULL, 99)`).run();
  migrateTodoOutcomeColumns(db);
  assert.equal((db.prepare(`SELECT resolution FROM todo_outcome WHERE todo_id = 1`).get() as { resolution: string }).resolution, 'declined');
  assert.ok(!columns(db).includes('resolution'));
});

const LEGACY_DDL = `CREATE TABLE author_feedback_outcome (
  todo_id INTEGER PRIMARY KEY REFERENCES project_todo(id) ON DELETE CASCADE,
  resolution TEXT, public_note TEXT, duplicate_of TEXT, updated_at INTEGER NOT NULL)`;

const tables = (db: Database.Database) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%outcome' ORDER BY name`).all() as { name: string }[])
    .map((t) => t.name);

test('the table of the former plugin name is renamed, with its rows, once the columns are gone', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE project_todo (id INTEGER PRIMARY KEY, text TEXT, updated_at INTEGER)`);
  db.exec(LEGACY_DDL);
  db.prepare(`INSERT INTO project_todo VALUES (1, 'TIM-0001', 10)`).run();
  db.prepare(`INSERT INTO author_feedback_outcome VALUES (1, 'fixed', 'Thanks!', NULL, 10)`).run();
  migrateTodoOutcomeColumns(db);
  migrateTodoOutcomeColumns(db);
  assert.deepEqual(tables(db), ['todo_outcome']);
  assert.deepEqual(db.prepare(`SELECT * FROM todo_outcome`).all(), [
    { todo_id: 1, resolution: 'fixed', public_note: 'Thanks!', duplicate_of: null, updated_at: 10 },
  ]);
  // The renamed table has the schema the plugin creates on a fresh install.
  const fresh = new Database(':memory:');
  fresh.exec(`CREATE TABLE project_todo (id INTEGER PRIMARY KEY)`);
  fresh.exec(TODO_OUTCOME_DDL);
  assert.deepEqual(db.prepare(`PRAGMA table_info(todo_outcome)`).all(), fresh.prepare(`PRAGMA table_info(todo_outcome)`).all());
  // Its foreign key still follows the idea.
  db.prepare(`DELETE FROM project_todo WHERE id = 1`).run();
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM todo_outcome`).get() as { n: number }).n, 0);
});

test('legacy columns and the former table together: renamed first, its outcome wins over the column', () => {
  const db = oldSchema();
  db.exec(LEGACY_DDL);
  db.prepare(`INSERT INTO author_feedback_outcome VALUES (1, 'declined', NULL, NULL, 99)`).run();
  migrateTodoOutcomeColumns(db);
  assert.deepEqual(tables(db), ['todo_outcome']);
  assert.equal((db.prepare(`SELECT resolution FROM todo_outcome WHERE todo_id = 1`).get() as { resolution: string }).resolution, 'declined');
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM todo_outcome`).get() as { n: number }).n, 3);
  assert.deepEqual(columns(db), ['id', 'text', 'status', 'updated_at']);
});

test('both tables present: the current one is kept, the former one left alone', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE project_todo (id INTEGER PRIMARY KEY, text TEXT, updated_at INTEGER)`);
  db.exec(LEGACY_DDL);
  db.exec(TODO_OUTCOME_DDL);
  migrateTodoOutcomeColumns(db);
  assert.deepEqual(tables(db), ['author_feedback_outcome', 'todo_outcome']);
});
