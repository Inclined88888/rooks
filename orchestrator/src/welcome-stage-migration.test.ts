/**
 * Upgrade welcome (docs/ONBOARDING.md, `Upgrade welcome`): the accounts that
 * exist when `users.welcome_stage` appears were made before the new
 * onboarding, so they are flagged `signin`; an account made afterwards is not.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const home = mkdtempSync(join(tmpdir(), 'rooks-welcome-stage-'));
process.env.ROOKS_HOME = home;

// A database written before the column: one account, nothing else.
{
  const legacy = new Database(join(home, 'rooks.db'));
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_superadmin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
  `);
  legacy.prepare(`INSERT INTO users (id, email, name, password_hash, is_superadmin, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
    .run('u-old', 'old@example.com', 'Old', 'x', Date.now());
  legacy.close();
}

// Creating an account checks the licence's user quota.
await import('../tests/helpers/paid-license.js');
const { dbApi } = await import('./db.js');

test('an account that predates the column is flagged to sign in again', () => {
  assert.equal(dbApi.userWelcomeStage('u-old'), 'signin');
  assert.equal(dbApi.anyUserAwaitingWelcomeSignin(), true);
});

test('an account created after the migration has nothing to show', () => {
  const user = createTestAccount(dbApi, { email: 'new@example.com', name: 'New', passwordHash: 'x' });
  assert.equal(dbApi.userWelcomeStage(user.id), null);
});

test('the stage moves on and closes', () => {
  dbApi.setUserWelcomeStage('u-old', 'mascot');
  assert.equal(dbApi.userWelcomeStage('u-old'), 'mascot');
  assert.equal(dbApi.anyUserAwaitingWelcomeSignin(), false);
  dbApi.setUserWelcomeStage('u-old', null);
  assert.equal(dbApi.userWelcomeStage('u-old'), null);
});
