/**
 * `todo_later` → `project_todo` : la bascule d'une base qui existe déjà.
 *
 * Ce test ne porte pas sur le renommage du code (tsc en voit les ratés) mais sur
 * le seul raté qui serait SILENCIEUX : le garde de renommage posé après le bloc
 * de schéma. `CREATE TABLE IF NOT EXISTS project_todo` aurait alors déjà créé
 * une table vide, le garde l'aurait vue présente, aurait sauté — et les idées
 * seraient restées dans `todo_later`, invisibles, sans erreur nulle part.
 *
 * Ce fichier pose SON home (il n'importe pas `test-home.js`) : il doit écrire la
 * base AVANT que `db.ts` ne l'ouvre, or les imports ESM sont hissés.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'rooks-project-todo-mig-'));
process.env.ROOKS_HOME = home;

// Base "d'avant" : l'ancienne table, peuplée, avec son index et une permission
// déjà accordée sur l'ancien nom de domaine.
{
  const { default: Database } = await import('better-sqlite3');
  const old = new Database(join(home, 'rooks.db'));
  old.exec(`
    CREATE TABLE todo_later (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      project TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX idx_todo_later_status ON todo_later(status, created_at);
    CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE role_permissions (role_id TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY (role_id, permission));
    INSERT INTO roles (id, name, created_at) VALUES ('r1', 'lecteur', 0);
    INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'todo_later:read:all');
  `);
  old.prepare(
    `INSERT INTO todo_later (text, project, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('idée d\'avant le renommage', 'rooks', 1, 1);
  old.close();
}

const { db, dbApi } = await import('./db.js');

test('une idée notée avant le renommage survit sous le nouveau nom', () => {
  const items = dbApi.listProjectTodo();
  assert.equal(items.length, 1, 'la table renommée garde ses lignes');
  assert.equal(items[0]!.text, 'idée d\'avant le renommage');
  assert.equal(items[0]!.project, 'rooks');
});

test('l\'ancienne table a disparu — pas deux carnets côte à côte', () => {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((t) => t.name);
  assert.ok(names.includes('project_todo'));
  assert.equal(names.includes('todo_later'), false);
});

test('the granted permission leaves with the account tables, for the account plugin to migrate (TODO #906)', () => {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((t) => t.name);
  assert.equal(names.includes('role_permissions'), false);
  assert.deepEqual(dbApi.readLegacyAccountTable('role_permissions'), [{ role_id: 'r1', permission: 'todo_later:read:all' }]);
});

test('la colonne owner_user_id a bien été posée sur la table renommée', () => {
  // Le garde doit tenir AVANT la boucle `OWNED_TABLES`, qui interpole le nom de
  // la table en SQL : un renommage trop tardif la ferait échouer sur l'absente.
  const cols = (db.prepare(`PRAGMA table_info(project_todo)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('owner_user_id'));
  assert.ok(cols.includes('author'));
});
