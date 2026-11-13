/**
 * Envelopes kept outside `secrets` and `plugin_kv` rotate with the vault: a
 * column the rotation forgot would be stranded under a key that no longer
 * exists (the machines' device tokens, multi-machine P2c).
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.js';
import { isSealed, seal } from './box.js';
import { machineTokenIdentity, sealedColumnRows } from './sealed-columns.js';
import { openWithVault, rekeyVault, recoverVaultRotation, sealWithVault } from './store.js';
import { readPendingKey, writePendingKey } from './key.js';
import { randomBytes } from 'node:crypto';

test('a missing table holds nothing', () => {
  assert.deepEqual(sealedColumnRows(), []);
});

test('a key rotation reseals the machines tokens in the same commit', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, token_enc TEXT NOT NULL)`);
  const identity = machineTokenIdentity('m-1');
  db.prepare(`INSERT INTO machines (id, token_enc) VALUES (?, ?)`).run('m-1', sealWithVault('tdev_secret', identity));
  // A legacy plain value is not an envelope: not listed, never "opened".
  db.prepare(`INSERT INTO machines (id, token_enc) VALUES (?, ?)`).run('m-2', 'not-an-envelope');
  assert.deepEqual(sealedColumnRows().map((row) => row.key), ['m-1']);
  const before = (db.prepare(`SELECT token_enc FROM machines WHERE id = 'm-1'`).get() as { token_enc: string }).token_enc;

  const { rotated } = rekeyVault();
  assert.ok(rotated >= 1);
  const after = (db.prepare(`SELECT token_enc FROM machines WHERE id = 'm-1'`).get() as { token_enc: string }).token_enc;
  assert.equal(isSealed(after), true);
  assert.notEqual(after, before);
  assert.equal(openWithVault(after, identity), 'tdev_secret');
  // Bound to its row: the same envelope does not open as another machine's.
  assert.throws(() => openWithVault(after, machineTokenIdentity('m-2')));
});

test('a machines token alone is a rotation witness', () => {
  // The crash window of a rotation: the rows were committed under the
  // candidate, the candidate was not promoted yet. The only envelope left is a
  // machine's token: the recovery must read it and promote the candidate.
  db.exec(`DELETE FROM machines`);
  const candidate = randomBytes(32);
  const identity = machineTokenIdentity('m-3');
  db.prepare(`INSERT INTO machines (id, token_enc) VALUES (?, ?)`).run('m-3', seal('tdev_after_commit', candidate, identity));
  writePendingKey(candidate);
  assert.equal(recoverVaultRotation(), 'promoted');
  assert.equal(readPendingKey(), null);
  const stored = (db.prepare(`SELECT token_enc FROM machines WHERE id = 'm-3'`).get() as { token_enc: string }).token_enc;
  assert.equal(openWithVault(stored, identity), 'tdev_after_commit');
});
