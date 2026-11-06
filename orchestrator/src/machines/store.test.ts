/**
 * The fleet table: one fleet per local account, and a token that is never
 * stored in clear nor readable from another row.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
await import('../../tests/helpers/paid-license.js');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, dbApi } from '../db.js';
import { isSealed } from '../secrets/box.js';
import {
  deleteMachine, getOwnedMachine, listMachines, machineToken, recordMachineStatus, renameMachine,
  savePairedMachine, toPublicMachine,
} from './store.js';

const alice = createTestAccount(dbApi, { email: 'alice@example.com', name: 'Alice', passwordHash: 'x', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: 'x' });
const remoteUser = { email: 'alice@vps', name: 'Alice', is_superadmin: true };

test('the token is sealed, bound to its row, and absent from the public form', () => {
  const { row, created } = savePairedMachine({
    ownerUserId: alice.id, name: 'VPS', url: 'https://vps.example.com', token: 'tdev_alice', remoteDeviceId: 'd1', remoteUser,
  });
  assert.equal(created, true);
  assert.equal(isSealed(row.token_enc), true);
  assert.ok(!row.token_enc.includes('tdev_alice'));
  assert.equal(machineToken(row), 'tdev_alice');
  assert.ok(!JSON.stringify(toPublicMachine(row)).includes('enc:1:'));
  // An envelope moved onto another row does not open there.
  const other = savePairedMachine({
    ownerUserId: alice.id, name: 'NAS', url: 'https://nas.lan', token: 'tdev_nas', remoteDeviceId: 'd2', remoteUser,
  }).row;
  assert.throws(() => machineToken({ id: other.id, token_enc: row.token_enc }));
});

test('another account sees nothing, renames nothing, deletes nothing', () => {
  const [mine] = listMachines(alice.id);
  assert.ok(mine);
  assert.deepEqual(listMachines(bob.id), []);
  assert.equal(getOwnedMachine(bob.id, mine.id), undefined);
  assert.equal(renameMachine(bob.id, mine.id, 'stolen'), undefined);
  assert.equal(getOwnedMachine(alice.id, mine.id)!.name, 'VPS');
  assert.equal(deleteMachine(bob.id, mine.id), false);
  assert.ok(getOwnedMachine(alice.id, mine.id));
});

test('pairing the same URL again keeps the id and replaces the token', () => {
  const first = listMachines(alice.id).find((m) => m.url === 'https://vps.example.com')!;
  const again = savePairedMachine({
    ownerUserId: alice.id, name: 'ignored', url: 'https://vps.example.com', token: 'tdev_alice_2', remoteDeviceId: 'd9', remoteUser,
  });
  assert.equal(again.created, false);
  assert.equal(again.row.id, first.id);
  assert.equal(again.row.name, 'VPS');
  assert.equal(again.replacedDeviceId, 'd1');
  assert.equal(machineToken(again.row), 'tdev_alice_2');
  // The same URL in Bob's fleet is Bob's own row.
  const bobs = savePairedMachine({
    ownerUserId: bob.id, name: 'VPS', url: 'https://vps.example.com', token: 'tdev_bob', remoteDeviceId: 'd3', remoteUser,
  });
  assert.equal(bobs.created, true);
  assert.notEqual(bobs.row.id, first.id);
});

test('a status keeps the last version seen online', () => {
  const row = listMachines(alice.id)[0]!;
  recordMachineStatus(row.id, { status: 'online', version: '0.1.5', apiLevel: 1 }, 1000);
  recordMachineStatus(row.id, { status: 'unreachable' }, 2000);
  const after = getOwnedMachine(alice.id, row.id)!;
  assert.equal(after.status, 'unreachable');
  assert.equal(after.version, '0.1.5');
  assert.equal(after.api_level, 1);
  assert.equal(after.last_ok_at, 1000);
  assert.equal(after.last_checked_at, 2000);
});

test('a deleted account takes its fleet with it', () => {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(bob.id);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM machines WHERE owner_user_id = ?`).get(bob.id) as { n: number }).n, 0);
});
