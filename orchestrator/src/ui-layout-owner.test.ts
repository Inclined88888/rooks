/**
 * T.1 — ui_layout is keyed by (owner, scope). Existing rows become the
 * machine template (`owner=''`); a later PUT by a user copy-on-writes
 * their own row and leaves the template (and every neighbour) alone.
 *
 * The migration test seeds the *old* PK (scope only) before `db.ts` loads,
 * because that module migrates at import time.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-ui-layout-owner-'));
process.env.ROOKS_HOME = HOME;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
const dbPath = join(HOME, 'rooks.db');
mkdirSync(HOME, { recursive: true });

const seed = new Database(dbPath);
const populated = JSON.stringify([{ id: 'agenda', rail: 'droite', rang: 1 }]);
seed.exec(`
  CREATE TABLE ui_layout (
    scope TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
seed.prepare(`INSERT INTO ui_layout (scope, value, updated_at) VALUES (?, ?, ?)`)
  .run('cockpit', populated, 1_700_000_000_000);
seed.close();

const { db, dbApi } = await import('./db.js');

test('a populated pre-T.1 database migrates its rows to owner=\'\'', () => {
  const cols = (db.prepare(`PRAGMA table_info(ui_layout)`).all() as { name: string }[])
    .map((c) => c.name);
  assert.ok(cols.includes('owner'), 'rebuild must add the owner column');
  const rows = db.prepare(`SELECT owner, scope, value FROM ui_layout`).all() as
    { owner: string; scope: string; value: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.owner, '');
  assert.equal(rows[0]?.scope, 'cockpit');
  assert.equal(rows[0]?.value, populated);
});

test('GET falls back to the template; PUT copy-on-writes the caller only', () => {
  const template = JSON.stringify([{ id: 'template' }]);
  const ada = JSON.stringify([{ id: 'ada' }]);
  const bob = JSON.stringify([{ id: 'bob' }]);

  dbApi.uiLayoutSet('', 'chat.columns', template);
  const fallback = dbApi.uiLayoutGet('user-ada', 'chat.columns');
  assert.equal(fallback?.value, template, 'unread user must see the machine template');

  dbApi.uiLayoutSet('user-ada', 'chat.columns', ada);
  assert.equal(dbApi.uiLayoutGet('user-ada', 'chat.columns')?.value, ada);
  assert.equal(dbApi.uiLayoutGet('user-bob', 'chat.columns')?.value, template);
  assert.equal(dbApi.uiLayoutGet('', 'chat.columns')?.value, template);

  dbApi.uiLayoutSet('user-bob', 'chat.columns', bob);
  assert.equal(dbApi.uiLayoutGet('user-ada', 'chat.columns')?.value, ada);
  assert.equal(dbApi.uiLayoutGet('user-bob', 'chat.columns')?.value, bob);
  assert.equal(dbApi.uiLayoutGet('', 'chat.columns')?.value, template);
});
