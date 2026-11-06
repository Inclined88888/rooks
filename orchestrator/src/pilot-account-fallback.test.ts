/**
 * TODO #701 — the pilot of a series leaves a dry account for another
 * connection of its owner, then the automatic levels; tasks keep the #52 guard.
 *
 * Incident of 31/10/2026: `timon.main` dry on `claude@aeeca8b0ac`, its series
 * rule `orchestrator` naming that same account. The cascade stopped at the
 * account guard: pilot not swapped, wakes refused, while the host's `claude`
 * and `codex` still had quota.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-pilot-account-fallback-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';
await import('../tests/helpers/paid-license.js');

const { db, dbApi } = await import('./db.js');
const accounts = await import('./backends/accounts.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { fallbackFor, redirectIfStillDry, switchSeriesToFallback, clearBackendCooldown } = await import('./backend-fallback.js');
const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');
const { systemMissionId } = await import('./notify.js');
const { quietWindow, waitUntil } = await import('../tests/helpers/wait-until.js');
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}
setBackendBinaryAvailabilityForTest(() => true);

const rom = createTestAccount(dbApi, { email: 'robin@example.com', name: 'Robin', passwordHash: 'x', isSuperadmin: true });
const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: 'x' });
const bea = createTestAccount(dbApi, { email: 'bea@example.com', name: 'Bea', passwordHash: 'x' });

const romAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Robin', ownerUserId: rom.id, createdBy: rom.id });
const adaPerso = accounts.createBackendAccount({ backend: 'claude', name: 'Ada perso', ownerUserId: ada.id });
const adaPro = accounts.createBackendAccount({ backend: 'claude', name: 'Ada pro', ownerUserId: ada.id });
// "Ada perso" must be Ada's default connection, i.e. her oldest account. Both
// are created in the same millisecond, and equal `created_at` fall back to the
// random id: half the runs made "Ada pro" the default (TODO #873).
db.prepare('UPDATE backend_accounts SET created_at = created_at - 1000 WHERE id = ?').run(adaPerso.id);
const beaAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Bea', ownerUserId: bea.id });
const romId = `claude@${romAccount.id}`;
const adaPersoId = `claude@${adaPerso.id}`;
const adaProId = `claude@${adaPro.id}`;
const beaId = `claude@${beaAccount.id}`;

const HOUR = 3_600_000;
function dry(backend: string): void {
  dbApi.setBackendCooldown(backend, Date.now() + HOUR, 'five_hour', true, 'rate_limit');
}
function reset(): void {
  for (const b of ['claude', 'codex', 'grok', romId, adaPersoId, adaProId, beaId]) clearBackendCooldown(b);
  setBackendBinaryAvailabilityForTest(() => true);
}
/** By series, not a global count: the alerts of the tests above land
 *  asynchronously, so no baseline taken here could be trusted. */
function strandedAlerts(seriesId: string) {
  return dbApi.listNotifications({ limit: 500 })
    .filter((n) => n.title.startsWith('Orchestrator stopped') && (n.body ?? '').includes(seriesId));
}

test('the incident: a pilot dry on its account, its rule naming that account, moves to the host sign-in, same model', () => {
  reset();
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'orchestrator', romId, 'opus');
  dry(romId);
  const target = fallbackFor(romId, { seriesId, scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: rom.id });
  assert.deepEqual(target, { backend: 'claude', model: 'opus' });
});

test('a pilot whose default connection is dry too moves to another account of its owner', () => {
  reset();
  dry(adaPersoId);
  const target = fallbackFor(adaPersoId, { seriesId: null, scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: ada.id });
  assert.deepEqual(target, { backend: adaProId, model: 'opus' });
});

test('a granted account counts as the owner\'s; another user\'s account never does', () => {
  reset();
  dry(adaPersoId);
  dry(adaProId);
  // Equivalence and the global setting out of reach: only accounts remain.
  setBackendBinaryAvailabilityForTest((b) => b.startsWith('claude'));
  const scope = { seriesId: null, scope: 'orchestrator' as const, fromModel: 'opus', missionOwnerUserId: ada.id };
  assert.equal(fallbackFor(adaPersoId, scope), null, 'Bea\'s account is not Ada\'s to use');
  accounts.grantBackendAccount(beaAccount.id, ada.id, rom.id);
  try {
    assert.equal(fallbackFor(adaPersoId, scope)?.backend, beaId, 'granted to Ada, so hers to use');
  } finally {
    accounts.revokeBackendAccountGrant(beaAccount.id, ada.id);
  }
});

test('the superadmin is never moved to another user\'s account either', () => {
  reset();
  dry(romId);
  dry('claude');
  setBackendBinaryAvailabilityForTest((b) => b.startsWith('claude'));
  const target = fallbackFor(romId, { seriesId: null, scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: rom.id });
  assert.equal(target, null, 'Ada\'s and Bea\'s accounts stay theirs');
});

test('past its own provider, the pilot drops to equivalence then the global fallback', () => {
  reset();
  dry(romId);
  dry('claude');
  assert.equal(
    fallbackFor(romId, { seriesId: null, scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: rom.id })?.backend,
    'codex',
  );
});

test('an unknown owner tries no account, the automatic levels still apply', () => {
  reset();
  dry(romId);
  assert.equal(fallbackFor(romId, { seriesId: null, scope: 'orchestrator', fromModel: 'opus' })?.backend, 'codex');
});

test('the wake paths take the same way out', async () => {
  reset();
  dry(adaPersoId);
  // A resumed pilot: its row already carries the account.
  assert.equal(
    (await redirectIfStillDry(adaPersoId, { seriesId: null, scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: ada.id }))?.backend,
    adaProId,
  );
  // A wake spawned from the agent's bare backend, resolved for the owner.
  assert.equal(
    (await redirectIfStillDry('claude', { seriesId: null, scope: 'orchestrator', fromModel: 'opus', ownerUserId: ada.id }))?.backend,
    adaProId,
  );
});

test('tasks keep the #52 guard: an account never falls back automatically', () => {
  reset();
  dry(adaPersoId);
  assert.equal(fallbackFor(adaPersoId, { seriesId: null, scope: 'code', fromModel: 'opus', ownerUserId: ada.id }), null);
  assert.equal(fallbackFor(adaPersoId, { seriesId: null, scope: 'code', fromModel: 'opus', missionOwnerUserId: ada.id }), null);
});

test('an explicit "no fallback" rule stops the pilot, without cascade', () => {
  reset();
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'orchestrator', null, null);
  dry(romId);
  assert.equal(fallbackFor(romId, { seriesId, scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: rom.id }), null);
});

test('TIMON_FALLBACK_ENABLED=0 still disables everything', () => {
  reset();
  dry(romId);
  process.env.TIMON_FALLBACK_ENABLED = '0';
  invalidateSettingsCache();
  try {
    assert.equal(fallbackFor(romId, { seriesId: null, scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: rom.id }), null);
  } finally {
    process.env.TIMON_FALLBACK_ENABLED = '1';
    invalidateSettingsCache();
  }
});

test('a stranded pilot raises ONE urgent alert per outage, saying what to do', async () => {
  reset();
  dry(romId);
  dry('claude');
  setBackendBinaryAvailabilityForTest((b) => b.startsWith('claude'));
  for (let i = 0; i < 3; i++) {
    assert.equal(fallbackFor(romId, { seriesId: 'abcdef12-series', scope: 'orchestrator', fromModel: 'opus', missionOwnerUserId: rom.id }), null);
  }
  await waitUntil(() => strandedAlerts('abcdef12-series').length > 0, 'the stranded-pilot alert');
  await quietWindow();
  const alerts = strandedAlerts('abcdef12-series');
  assert.equal(alerts.length, 1);
  const alert = alerts[0]!;
  assert.equal(alert.urgent, 1);
  assert.match(alert.body ?? '', /timon series fallback set --series abcdef12-series --scope orchestrator/);
  // A task scope strands no pilot: no alert. A new outage, or the once-per-outage
  // guard above would keep this quiet whatever the scope; the bare backend too,
  // since the #52 guard stops an account before it could ever raise one.
  dry(romId);
  dry('claude');
  for (const from of [romId, 'claude']) {
    assert.equal(fallbackFor(from, { seriesId: 'task-scope-series', scope: 'code', fromModel: 'opus', ownerUserId: rom.id }), null);
  }
  await quietWindow();
  assert.deepEqual(strandedAlerts('task-scope-series'), []);
});

function seriesNotices(agent: string): { title: string; body: string }[] {
  return dbApi.listMessagesForMission(systemMissionId(), 500)
    .filter((m) => m.kind === 'notification' && m.to_agent === agent)
    .map((m) => JSON.parse(m.payload) as { title: string; body: string })
    .filter((p) => p.title.startsWith('Quota exhausted'));
}

function seedSeries(pilotAgent: string, pilotBackend: string, owner: string): { seriesId: string; pilotId: string } {
  const seriesId = randomUUID();
  const pilotId = randomUUID();
  dbApi.createMission(pilotId, pilotAgent, 'series pilot', undefined, owner);
  dbApi.setMissionLlmOverrides(pilotId, pilotBackend, 'opus');
  dbApi.finishMission(pilotId, 'terminated', 0, 'killed');
  dbApi.setSeriesFallback(seriesId, 'orchestrator', pilotBackend, 'opus');
  for (let i = 0; i < 4; i++) {
    const id = randomUUID();
    dbApi.createTask(id, `slice ${i}`, 'p.coder', {
      type: 'code', seriesId, creatorMissionId: pilotId, ownerUserId: owner,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'rate limit' });
  }
  return { seriesId, pilotId };
}

test('a dead pilot on a dry account is repointed to its owner\'s other connection; one notice, to the series\' pilot', async () => {
  reset();
  dry(romId);
  dry('grok');
  const { seriesId, pilotId } = seedSeries('p1.main', romId, rom.id);
  // One switchover per task that died on the dry backend, in the same second.
  await Promise.all([0, 1, 2, 3].map(() => switchSeriesToFallback(seriesId, {
    pilotMissionId: pilotId,
    reason: 'quota',
    respawnDeadPilot: false,
  })));
  assert.equal(dbApi.getMission(pilotId)?.backend_override, 'claude');
  const notices = seriesNotices('p1.main');
  assert.equal(notices.length, 1, 'one switchover, one notification');
  assert.equal(notices[0]!.title, 'Quota exhausted — series switched to its fallback plan');
  for (const t of dbApi.listTasksBySeries(seriesId)) assert.equal(t.backend_override, 'codex', 'moved once, not bounced on');
});

test('a pilot left in place is announced as such', async () => {
  reset();
  dry(romId);
  dry('grok');
  const { seriesId, pilotId } = seedSeries('p2.main', romId, rom.id);
  // An explicit refusal for the pilot: the tasks move, the pilot stays.
  dbApi.setSeriesFallback(seriesId, 'orchestrator', null, null);
  await switchSeriesToFallback(seriesId, { pilotMissionId: pilotId, reason: 'quota', respawnDeadPilot: false });
  assert.equal(dbApi.getMission(pilotId)?.backend_override, romId, 'the pilot did not move');
  const notices = seriesNotices('p2.main');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.title, 'Quota exhausted — tasks switched, orchestrator NOT moved');
  assert.match(notices[0]!.body, /Orchestrator: NOT moved/);
});
