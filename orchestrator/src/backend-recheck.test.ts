/**
 * A sidelined backend is re-tested before a spawn is refused (2026-10-18:
 * codex refused for 5 h on an estimate while its usage probe showed the
 * account green).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-recheck-test-'));
process.env.ROOKS_FALLBACK_ENABLED = '1';
process.env.ROOKS_FALLBACK_BACKEND = 'claude';
process.env.ROOKS_FALLBACK_MODEL = '';

const { dbApi } = await import('./db.js');
const {
  backendStillDry, setUsageProbeForTest, usageVerdict, RECHECK_INTERVAL_MS, sweepQuotaCooldowns, startQuotaRecheckSweep,
} = await import('./backend-recheck.js');
const { redirectIfStillDry } = await import('./backend-fallback.js');

const HOUR = 3_600_000;

/** Records an exclusion as if the failure had happened `agoMs` ago. */
function sideline(backend: string, agoMs: number, kind: 'rate_limit' | 'exhausted' | 'unavailable' = 'rate_limit'): void {
  const realNow = Date.now;
  const at = realNow() - agoMs;
  Date.now = () => at;
  try {
    dbApi.setBackendCooldown(backend, at + 5 * HOUR, null, false, kind);
  } finally {
    Date.now = realNow;
  }
}

function countingProbe(answer: Awaited<ReturnType<typeof usageVerdict>>): { calls: () => number } {
  let n = 0;
  setUsageProbeForTest(async () => { n++; return answer; });
  return { calls: () => n };
}

const STALE = RECHECK_INTERVAL_MS + 1_000;

{
  const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  // A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
  await stubCliBinaries('claude', 'codex');
  await stubCodexSignIn();
  await mountOfficialProviders();
}

test('usageVerdict: a full window with a reset ahead is dry, until its reset', () => {
  const now = Date.parse('2026-10-18T15:30:00Z');
  const v = usageVerdict({
    windows: {
      five_hour: { utilization: 100, resets_at: '2026-10-18T15:40:00Z' },
      seven_day: { utilization: 16, resets_at: '2026-10-22T00:00:00Z' },
    },
    extra: null,
  }, now);
  assert.deepEqual(v, { state: 'dry', resetsAt: Date.parse('2026-10-18T15:40:00Z'), window: 'five_hour' });
});

test('usageVerdict: a full window whose reset has passed is open; no window says nothing', () => {
  const now = Date.parse('2026-10-18T19:00:00Z');
  assert.deepEqual(usageVerdict({
    windows: { five_hour: { utilization: 100, resets_at: '2026-10-18T15:40:00Z' } },
    extra: null,
  }, now), { state: 'open' });
  assert.equal(usageVerdict({ windows: { five_hour: null }, extra: null }, now), null);
});

test('no exclusion recorded: nothing is asked', async () => {
  dbApi.clearBackendCooldown('codex');
  const probe = countingProbe({ state: 'open' });
  assert.equal(await backendStillDry('codex', { claimTrial: true }), false);
  assert.equal(probe.calls(), 0);
});

test('a failure younger than the interval is the freshest evidence: refused without probing', async () => {
  sideline('codex', 10_000);
  const probe = countingProbe({ state: 'open' });
  assert.equal(await backendStillDry('codex', { claimTrial: true }), true);
  assert.equal(probe.calls(), 0);
});

test('the incident: estimated 5 h exclusion, probe shows the quota open → lifted', async () => {
  sideline('codex', STALE);
  const probe = countingProbe({ state: 'open' });
  assert.equal(await backendStillDry('codex', { claimTrial: true }), false);
  assert.equal(probe.calls(), 1);
  assert.equal(dbApi.getBackendCooldown('codex'), undefined, 'exclusion removed');
});

test('probe confirms a full window → refused, and the reset time becomes the provider one', async () => {
  sideline('codex', STALE);
  const resetsAt = Date.now() + 20 * 60_000;
  countingProbe({ state: 'dry', resetsAt, window: 'five_hour' });
  assert.equal(await backendStillDry('codex', { claimTrial: true }), true);
  const row = dbApi.getBackendCooldown('codex');
  assert.equal(row?.until, resetsAt);
  assert.equal(row?.exact, 1);
  assert.equal(row?.quota_window, 'five_hour');
});

test('no probe answer: one trial spawn, then the next waits for its outcome', async () => {
  sideline('codex', STALE);
  countingProbe(null);
  assert.equal(await backendStillDry('codex', { claimTrial: false }), false, 'a router lets it through');
  assert.equal(await backendStillDry('codex', { claimTrial: false }), false, 'without taking the slot');
  assert.equal(await backendStillDry('codex', { claimTrial: true }), false, 'the spawn takes the slot');
  assert.equal(await backendStillDry('codex', { claimTrial: true }), true, 'a second spawn is refused');
  assert.ok(dbApi.getBackendCooldown('codex'), 'only a turn that succeeds lifts the record');
});

test('402 and circuit breaker are not settled by a usage window: the spawn is the test', async () => {
  for (const kind of ['exhausted', 'unavailable'] as const) {
    sideline('codex', STALE, kind);
    const probe = countingProbe({ state: 'open' });
    assert.equal(await backendStillDry('codex', { claimTrial: true }), false, kind);
    assert.equal(probe.calls(), 0, `${kind}: no probe`);
    assert.equal(await backendStillDry('codex', { claimTrial: true }), true, `${kind}: one trial at a time`);
  }
});

test('a record changed while the probe ran wins over the probe answer', async () => {
  sideline('codex', STALE);
  setUsageProbeForTest(async () => {
    dbApi.setBackendCooldown('codex', Date.now() + HOUR, null, false, 'rate_limit');
    return { state: 'open' };
  });
  assert.equal(await backendStillDry('codex', { claimTrial: true }), true);
  assert.ok(dbApi.getBackendCooldown('codex'));
});

test('redirectIfStillDry: an exclusion the probe disproves redirects nowhere', async () => {
  sideline('codex', STALE);
  countingProbe({ state: 'open' });
  assert.equal(await redirectIfStillDry('codex'), null);

  sideline('codex', 10_000);
  assert.ok(await redirectIfStillDry('codex'), 'a fresh failure still redirects');
  setUsageProbeForTest(null);
  dbApi.clearBackendCooldown('codex');
});

// TIM-0122 — an account nobody spawns on is re-tested by the background sweep.
{
  const { createBackendAccount, accountInstance, getBackendAccount } = await import('./backends/accounts.js');
  const { accountState } = await import('./plugins-bundled/backends/account-routes.js');

  const account = createBackendAccount({ backend: 'codex', name: 'Main', ownerUserId: null });
  const instance = accountInstance(account);
  const state = (): string => accountState(getBackendAccount(account.id)!);

  function recordingProbe(answer: Awaited<ReturnType<typeof usageVerdict>>): string[] {
    const asked: string[] = [];
    setUsageProbeForTest(async (name) => { asked.push(name); return answer; });
    return asked;
  }

  test('sweep: an account out of quota with no traffic is freed once its probe shows the quota open', async () => {
    sideline(instance, STALE);
    const asked = recordingProbe({ state: 'open' });
    assert.equal(state(), 'cooldown');
    await sweepQuotaCooldowns();
    assert.deepEqual(asked, [instance], 'the account itself is probed, not the bare backend');
    assert.equal(state(), 'active');
  });

  test('sweep: a probe that confirms the window full keeps the account sidelined until the provider reset', async () => {
    sideline(instance, STALE);
    const resetsAt = Date.now() + 40 * 60_000;
    recordingProbe({ state: 'dry', resetsAt, window: 'five_hour' });
    await sweepQuotaCooldowns();
    assert.equal(state(), 'cooldown');
    assert.equal(dbApi.getBackendCooldown(instance)?.until, resetsAt);
    dbApi.clearBackendCooldown(instance);
  });

  test('sweep: no probe twice — overlapping sweeps, a spawn at the same moment, a sweep right after', async () => {
    sideline(instance, STALE);
    let calls = 0;
    let release: (v: null) => void = () => {};
    setUsageProbeForTest(() => { calls++; return new Promise((resolve) => { release = resolve; }); });
    const first = sweepQuotaCooldowns();
    const second = sweepQuotaCooldowns();
    const spawn = backendStillDry(instance, { claimTrial: true });
    await new Promise((resolve) => setImmediate(resolve));
    release(null);
    await Promise.all([first, second, spawn]);
    assert.equal(calls, 1, 'one request shared by both sweeps and the spawn');
    await sweepQuotaCooldowns();
    assert.equal(calls, 1, 'an unanswered probe is not asked again before the interval');
    assert.ok(dbApi.getBackendCooldown(instance), 'no answer lifts nothing');
    dbApi.clearBackendCooldown(instance);
  });

  test('sweep: sign-in and breaker exclusions are never settled by a usage probe', async () => {
    for (const kind of ['exhausted', 'unavailable'] as const) {
      sideline(instance, STALE, kind);
      const asked = recordingProbe({ state: 'open' });
      await sweepQuotaCooldowns();
      assert.deepEqual(asked, [], kind);
      assert.equal(dbApi.getBackendCooldown(instance)?.kind, kind);
    }
    dbApi.clearBackendCooldown(instance);
  });

  test('sweep: the timer frees the account on its own, and stops when asked', async () => {
    sideline(instance, STALE);
    const asked = recordingProbe({ state: 'open' });
    const stop = startQuotaRecheckSweep(20);
    try {
      for (let i = 0; i < 100 && state() !== 'active'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      stop();
    }
    assert.equal(state(), 'active');
    assert.equal(asked.length, 1);
    setUsageProbeForTest(null);
  });
}
