import { statSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_PATH } from './paths.js';
import { db } from './db.js';

// The database the daemon itself opens, not a copy of its gestures (TODO #864).
test('the daemon database and its -wal / -shm are created owner-only', { skip: process.platform === 'win32' }, () => {
  db.exec('CREATE TABLE IF NOT EXISTS perms_probe (v TEXT)');
  db.prepare('INSERT INTO perms_probe VALUES (?)').run('x');
  for (const path of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    assert.equal(statSync(path).mode & 0o777, 0o600, path);
  }
});
