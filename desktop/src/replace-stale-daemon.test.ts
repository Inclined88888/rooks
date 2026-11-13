import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceStaleDaemon, waitUntilDaemonGone } from './replace-stale-daemon.js';
import type { HealthResult } from './health.js';
import { instanceId } from './service.js';

const home = '/tmp/rooks-stale';
const id = instanceId(home);
const matching = (): HealthResult => ({ ok: true, status: 200, identity: 'rooks', instance: id, version: '0.2.0' });
const stale = (): HealthResult => ({ ok: true, status: 200, identity: 'rooks', instance: id, version: '0.1.0' });
const down = (): HealthResult => ({ ok: false, status: null, error: 'refused' });

test('replaceStaleDaemon: matching version is a no-op', async () => {
  const result = await replaceStaleDaemon(matching(), {
    packaged: true, home, appVersion: '0.2.0', serviceInstalled: true,
    probe: async () => matching(),
    waitForMatch: async () => matching(),
    waitUntilGone: async () => down(),
    stopService: async () => assert.fail('must not stop'),
    upgradeService: async () => assert.fail('must not upgrade'),
    startService: async () => assert.fail('must not start'),
    startEmbedded: async () => assert.fail('must not embed'),
  });
  assert.equal(result.action, 'none');
});

test('replaceStaleDaemon: stops, restages, and keeps a matching service', async () => {
  const calls: string[] = [];
  const result = await replaceStaleDaemon(stale(), {
    packaged: true, home, appVersion: '0.2.0', serviceInstalled: true,
    probe: async () => matching(),
    waitForMatch: async () => matching(),
    waitUntilGone: async () => { calls.push('gone'); return down(); },
    stopService: async () => { calls.push('stop'); },
    upgradeService: async () => { calls.push('upgrade'); },
    startService: async () => { calls.push('start'); },
    startEmbedded: async () => assert.fail('service matched'),
  });
  assert.deepEqual(calls, ['stop', 'gone', 'upgrade', 'start']);
  assert.equal(result.action, 'replaced');
  if (result.action === 'replaced') assert.equal(result.via, 'service');
});

test('replaceStaleDaemon: falls back to embedded when service stays stale', async () => {
  const result = await replaceStaleDaemon(stale(), {
    packaged: true, home, appVersion: '0.2.0', serviceInstalled: true,
    probe: async () => matching(),
    waitForMatch: async () => stale(),
    waitUntilGone: async () => down(),
    stopService: async () => undefined,
    upgradeService: async () => undefined,
    startService: async () => undefined,
    startEmbedded: async () => matching(),
  });
  assert.equal(result.action, 'replaced');
  if (result.action === 'replaced') assert.equal(result.via, 'embedded');
});

test('waitUntilDaemonGone stops when Rooks leaves the port', async () => {
  let n = 0;
  const last = await waitUntilDaemonGone(async () => {
    n += 1;
    return n < 3 ? stale() : down();
  }, home, 5_000, async () => undefined);
  assert.equal(last.ok, false);
  assert.equal(n, 3);
});
