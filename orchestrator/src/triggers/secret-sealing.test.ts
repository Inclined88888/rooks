/**
 * Trigger secrets are sealed at rest (TODO #529): the column never holds the
 * value, a copy of the database (a backup) holds nothing usable, an envelope
 * moved to another trigger opens nothing, a key rotation carries them, and the
 * values stored in the clear before are sealed at boot.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { db } = await import('../db.js');
// Trigger secrets are sealed: the key goes to this test home's file, never to the OS keyring.
const { resolveMasterKey } = await import('../secrets/key.js');
resolveMasterKey({ keyring: null });
const { isSealed } = await import('../secrets/box.js');
const { rekeyVault } = await import('../secrets/store.js');
const { sealedColumnRows } = await import('../secrets/sealed-columns.js');
const {
  getTrigger, getTriggerRow, insertTrigger, sealLegacyTriggerSecrets, setTriggerOutboundSecret, setTriggerSecret,
} = await import('./store.js');

const SECRET = 'whsec_inbound-value-that-must-never-be-stored';
const OUTBOUND = 'whsec_outbound-value-that-must-never-be-stored';

function webhook(slug: string, secret: string | null = SECRET) {
  return insertTrigger({
    name: slug, slug, source: 'webhook', enabled: true, config: { auth: 'standard' }, filter: null,
    actions: [{ type: 'notify', title: 'x' }], secret, ownerUserId: null, createdBy: 'user',
    creatorAgent: null, actingAgent: null, grants: ['notify'], nextRunAt: null,
  });
}

const columns = (id: string) => db.prepare(`SELECT secret, outbound_secret FROM triggers WHERE id = ?`)
  .get(id) as { secret: string | null; outbound_secret: string | null };

test('the columns hold envelopes, the typed trigger the values', () => {
  const row = webhook('sealed-at-rest');
  setTriggerOutboundSecret(row.id, OUTBOUND);
  const stored = columns(row.id);
  assert.equal(isSealed(stored.secret!), true);
  assert.equal(isSealed(stored.outbound_secret!), true);
  assert.equal(stored.secret!.includes(SECRET), false);
  assert.equal(stored.outbound_secret!.includes(OUTBOUND), false);
  const trigger = getTrigger(row.id)!;
  assert.equal(trigger.secret, SECRET);
  assert.equal(trigger.outboundSecret, OUTBOUND);

  setTriggerSecret(row.id, `${SECRET}-rotated`);
  assert.equal(isSealed(columns(row.id).secret!), true);
  assert.equal(getTrigger(row.id)!.secret, `${SECRET}-rotated`);
});

test('a copy of the database holds no secret in the clear', () => {
  const row = webhook('backup-copy');
  setTriggerOutboundSecret(row.id, OUTBOUND);
  const dir = mkdtempSync(join(tmpdir(), 'trigger-backup-'));
  try {
    const copy = join(dir, 'copy.db');
    // What the backup routine does.
    db.prepare('VACUUM INTO ?').run(copy);
    const bytes = readFileSync(copy).toString('latin1');
    assert.equal(bytes.includes(SECRET), false);
    assert.equal(bytes.includes(OUTBOUND), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an envelope moved to another trigger opens nothing: that webhook has no secret', () => {
  const source = webhook('envelope-source');
  const target = webhook('envelope-target', 'whsec_target-own-secret-value');
  db.prepare(`UPDATE triggers SET secret = ? WHERE id = ?`).run(columns(source.id).secret, target.id);
  const moved = getTrigger(target.id);
  assert.ok(moved, 'the trigger stays readable');
  assert.equal(moved.secret, null);
  assert.equal(getTrigger(source.id)!.secret, SECRET);
  // An envelope no key opens aborts a key rotation, like any other sealed row.
  db.prepare(`DELETE FROM triggers WHERE id = ?`).run(target.id);
});

test('a key rotation carries the trigger secrets', () => {
  const row = webhook('rotated-key');
  setTriggerOutboundSecret(row.id, OUTBOUND);
  assert.ok(sealedColumnRows().some((r) => r.spec.table === 'triggers' && r.key === row.id));
  const before = columns(row.id);
  rekeyVault();
  const after = columns(row.id);
  assert.notEqual(after.secret, before.secret);
  assert.notEqual(after.outbound_secret, before.outbound_secret);
  const trigger = getTrigger(row.id)!;
  assert.equal(trigger.secret, SECRET);
  assert.equal(trigger.outboundSecret, OUTBOUND);
});

test('secrets stored in the clear before are sealed once, and keep verifying meanwhile', () => {
  const row = webhook('legacy-clear', null);
  db.prepare(`UPDATE triggers SET secret = ?, outbound_secret = ? WHERE id = ?`).run(SECRET, OUTBOUND, row.id);
  // Not sealed yet: still usable, so a boot that cannot reach the vault breaks nothing.
  assert.equal(getTrigger(row.id)!.secret, SECRET);
  assert.ok(sealLegacyTriggerSecrets() >= 2);
  const stored = columns(row.id);
  assert.equal(isSealed(stored.secret!), true);
  assert.equal(isSealed(stored.outbound_secret!), true);
  assert.equal(getTrigger(row.id)!.secret, SECRET);
  assert.equal(getTrigger(row.id)!.outboundSecret, OUTBOUND);
  assert.equal(sealLegacyTriggerSecrets(), 0, 'idempotent');
  assert.equal(getTriggerRow(row.id)!.secret, stored.secret);
});
