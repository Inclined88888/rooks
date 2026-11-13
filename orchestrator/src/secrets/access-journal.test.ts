/**
 * Access journal (SECRETS-VAULT.md §8) and write-time refusal of a `broker`
 * secret without a usable spec (§6.2, invariant §12.7).
 */
// Isolates ROOKS_HOME BEFORE any module touching Rooks state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbApi } from '../db.js';
import { pruneSecretAccessJournal } from '../events-archive.js';
import { invalidateSettingsCache } from '../settings.js';

const HTTP_SPEC = JSON.stringify({
  type: 'http',
  hosts: ['api.github.com'],
  inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
});

const sealed = (label: string) => `enc:1:iv:tag:${label}`;

test('a broker secret without a spec, or with an empty allowlist, is refused at the write', () => {
  assert.throws(
    () => dbApi.createSecret({ name: 'NO_SPEC', value_enc: sealed('a'), mode: 'broker' }),
    /broker_spec/,
  );
  assert.throws(
    () => dbApi.createSecret({
      name: 'EMPTY_HOSTS',
      value_enc: sealed('a'),
      mode: 'broker',
      broker_spec: JSON.stringify({ type: 'http', hosts: [], inject: { kind: 'header', name: 'A', template: '{{value}}' } }),
    }),
    /hosts/,
  );
  assert.equal(dbApi.getSecretsByName('NO_SPEC').length, 0);
  assert.equal(dbApi.getSecretsByName('EMPTY_HOSTS').length, 0);
});

test('an update is validated on the RESULTING row, not on the patch alone', () => {
  const injected = dbApi.createSecret({ name: 'WAS_INJECT', value_enc: sealed('a'), mode: 'inject' });
  // Mode flipped to broker with no spec in the patch: each field is innocent,
  // the resulting row is not.
  assert.throws(() => dbApi.updateSecret(injected.id, { mode: 'broker' }), /broker_spec/);
  assert.equal(dbApi.getSecret(injected.id)?.mode, 'inject');

  const broker = dbApi.createSecret({ name: 'BROKERED', value_enc: sealed('b'), mode: 'broker', broker_spec: HTTP_SPEC });
  assert.throws(
    () => dbApi.updateSecret(broker.id, {
      broker_spec: JSON.stringify({ type: 'http', hosts: [], inject: { kind: 'header', name: 'A', template: '{{value}}' } }),
    }),
    /hosts/,
  );
  assert.equal(dbApi.getSecret(broker.id)?.broker_spec, HTTP_SPEC);
  assert.throws(() => dbApi.updateSecret(broker.id, { broker_spec: null }), /broker_spec/);
});

test('recordSecretAccessMany writes a batch in one go and an empty list is a no-op', () => {
  const a = dbApi.createSecret({ name: 'BATCH_A', value_enc: sealed('aa'), mode: 'inject' });
  const b = dbApi.createSecret({ name: 'BATCH_B', value_enc: sealed('bb'), mode: 'inject' });
  dbApi.recordSecretAccessMany([]);
  assert.equal(dbApi.listSecretAccess(a.id).length, 0);
  assert.equal(dbApi.listSecretAccess(b.id).length, 0);

  dbApi.recordSecretAccessMany([
    { secret_id: a.id, name: a.name, mission_id: 'm-batch', agent: 'batch.coder', kind: 'inject', outcome: 'ok' },
    { secret_id: b.id, name: b.name, mission_id: 'm-batch', agent: 'batch.coder', kind: 'inject', outcome: 'ok' },
  ]);
  const rowsA = dbApi.listSecretAccess(a.id);
  const rowsB = dbApi.listSecretAccess(b.id);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsA[0]?.mission_id, 'm-batch');
  assert.equal(rowsA[0]?.kind, 'inject');
  assert.equal(Object.keys(rowsA[0]!).includes('value'), false);
  assert.equal(JSON.stringify([...rowsA, ...rowsB]).includes('enc:1:'), false);
});

test('the journal records the fact of a use and nothing that could be a value', () => {
  const secret = dbApi.createSecret({ name: 'JOURNALLED', value_enc: sealed('c'), mode: 'broker', broker_spec: HTTP_SPEC });
  dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, mission_id: 'm1', agent: 'a.coder', kind: 'broker', outcome: 'ok' });
  dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, mission_id: 'm1', agent: 'a.coder', kind: 'broker', outcome: 'denied', detail: 'host not allowed' });

  const rows = dbApi.listSecretAccess(secret.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.outcome).sort(), ['denied', 'ok']);
  assert.equal(rows.every((r) => r.agent === 'a.coder' && r.mission_id === 'm1'), true);
  // No field can carry a value, and none of the stored text contains one.
  assert.equal(Object.keys(rows[0]!).includes('value'), false);
  assert.equal(JSON.stringify(rows).includes('enc:1:'), false);
});

test('the journal survives the deletion of its secret — a use stays traceable', () => {
  const secret = dbApi.createSecret({ name: 'GONE_SOON', value_enc: sealed('d'), mode: 'inject' });
  dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, kind: 'inject', outcome: 'ok' });
  dbApi.deleteSecret(secret.id);
  const rows = dbApi.listSecretAccess(secret.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, 'GONE_SOON');
});

test('retention follows the events setting; 0 (the default) never prunes', () => {
  const secret = dbApi.createSecret({ name: 'OLD_USES', value_enc: sealed('e'), mode: 'inject' });
  const now = Date.now();
  dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, kind: 'inject', outcome: 'ok', at: now - 30 * 86_400_000 });
  dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, kind: 'inject', outcome: 'ok', at: now });

  delete process.env.ROOKS_EVENTS_HOT_DAYS;
  invalidateSettingsCache();
  assert.equal(pruneSecretAccessJournal(now), 0);
  assert.equal(dbApi.listSecretAccess(secret.id).length, 2);

  process.env.ROOKS_EVENTS_HOT_DAYS = '7';
  invalidateSettingsCache();
  try {
    assert.equal(pruneSecretAccessJournal(now), 1);
    assert.equal(dbApi.listSecretAccess(secret.id).length, 1);
  } finally {
    delete process.env.ROOKS_EVENTS_HOT_DAYS;
    invalidateSettingsCache();
  }
});
