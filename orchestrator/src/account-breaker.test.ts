/**
 * TODO #52 — a signed-out account is marked "sign in again", sidelines only
 * itself, and never falls back on its own to another subscription.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-account-breaker-'));
process.env.ROOKS_FALLBACK_ENABLED = '1';
process.env.ROOKS_FALLBACK_BACKEND = 'codex';
process.env.ROOKS_BREAKER_ENABLED = '1';
await import('../tests/helpers/paid-license.js');

const { dbApi } = await import('./db.js');
const accounts = await import('./backends/accounts.js');
const { isBackendName } = await import('./backends/index.js');
const { defaultEquivalentFallback } = await import('./backends/equivalence.js');
const { noteSterileTurn } = await import('./backend-breaker.js');
const { noteBackendUnavailable, isBackendCoolingDown, fallbackFor, redirectIfExhausted } = await import('./backend-fallback.js');
const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');
setBackendBinaryAvailabilityForTest(() => true);
const { BackendAccountError, resolveLaunchBackend } = await import('./backends/account-launch.js');

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: 'x' });
const perso = accounts.createBackendAccount({ backend: 'claude', name: 'Perso', ownerUserId: ada.id });
const pro = accounts.createBackendAccount({ backend: 'claude', name: 'Pro', ownerUserId: ada.id });
const persoId = `claude@${perso.id}`;
const proId = `claude@${pro.id}`;

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('the claude accounts are dispatchable instances', () => {
  assert.equal(isBackendName(persoId), true);
  assert.equal(isBackendName(proId), true);
});

test('an authentication failure marks the account, and only the account', () => {
  const trip = noteSterileTurn(persoId, 'result:empty', Date.now(), 'auth');
  assert.ok(trip, 'an auth failure trips at once');
  noteBackendUnavailable(trip);
  assert.equal(accounts.getBackendAccount(perso.id)?.status, 'reauth');
  assert.equal(isBackendCoolingDown(persoId), true);
  assert.equal(isBackendCoolingDown(proId), false, 'the other account keeps running');
  assert.equal(isBackendCoolingDown('claude'), false, 'the host sign-in keeps running');
  assert.equal(accounts.getBackendAccount(pro.id)?.status, 'active');
  assert.throws(() => resolveLaunchBackend(persoId, ada.id),
    (err: unknown) => err instanceof BackendAccountError && err.code === 'reauth');
});

test('an account never falls back automatically, a declared fallback still applies', () => {
  assert.equal(fallbackFor(persoId), null, 'neither equivalence nor the global setting');
  assert.ok(fallbackFor('claude'), 'the bare backend keeps its fallback plan');
  assert.deepEqual(fallbackFor(persoId, undefined, { backend: 'codex', model: null })?.backend, 'codex');
});

test('equivalence never offers an account its own backend', () => {
  const target = defaultEquivalentFallback(proId, 'opus', () => true);
  assert.notEqual(target?.backend, 'claude');
});

test('a task stored on the bare backend does not fall back when its owner\'s account is dry', () => {
  const bea = createTestAccount(dbApi, { email: 'bea@example.com', name: 'Bea', passwordHash: 'x' });
  const beaAccount = accounts.createBackendAccount({ backend: 'codex', name: 'Bea', ownerUserId: bea.id });
  const beaId = `codex@${beaAccount.id}`;
  dbApi.setBackendCooldown(beaId, Date.now() + 3_600_000, 'five_hour', true, 'rate_limit');
  const scope = { seriesId: null, scope: 'code' as const, fromModel: null, ownerUserId: bea.id };
  assert.equal(redirectIfExhausted('codex', scope), null, 'no automatic move to another subscription');
  assert.ok(redirectIfExhausted('codex', scope, { backend: 'claude', model: null }), 'a declared fallback still applies');
  assert.equal(redirectIfExhausted('codex', { ...scope, ownerUserId: ada.id }), null, 'the host sign-in is not dry');
});
