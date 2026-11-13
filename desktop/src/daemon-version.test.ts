import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonIsStale } from './daemon-version.js';
import type { HealthResult } from './health.js';

const own = { packaged: true, version: '0.1.7', builtAt: '2026-11-13T08:37:50.979Z' };
const up = (extra: Partial<Extract<HealthResult, { ok: true }>>): HealthResult => ({
  ok: true, status: 200, identity: 'timon', instance: 'abc', ...extra,
});

test('a packaged shell replaces a leftover daemon that is not this build', () => {
  assert.equal(daemonIsStale(up({}), own), true, 'an older probe has no version');
  assert.equal(daemonIsStale(up({ version: '0.1.7' }), own), true, 'the same version without this build time');
  assert.equal(daemonIsStale(up({ version: '0.1.7', builtAt: '2026-11-01T00:00:00.000Z' }), own), true);
  assert.equal(daemonIsStale(up({ version: '0.1.7', builtAt: own.builtAt }), own), false);
  assert.equal(daemonIsStale(up({}), { ...own, packaged: false }), false, 'a source checkout does not replace');
  assert.equal(daemonIsStale({ ok: true, status: 200, identity: 'foreign' }, own), false);
});
