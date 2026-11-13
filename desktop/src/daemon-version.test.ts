import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonVersionOf, daemonVersionStale, staleDaemonLog } from './daemon-version.js';
import type { HealthResult } from './health.js';

const home = '/tmp/rooks-home';
const ours = (version?: string): HealthResult => ({
  ok: true,
  status: 200,
  identity: 'rooks',
  instance: 'abc',
  ...(version !== undefined ? { version } : {}),
});

test('daemonVersionOf reads a non-empty version only', () => {
  assert.equal(daemonVersionOf(ours('0.2.1')), '0.2.1');
  assert.equal(daemonVersionOf(ours('  0.2.1  ')), '0.2.1');
  assert.equal(daemonVersionOf(ours('')), null);
  assert.equal(daemonVersionOf(ours()), null);
  assert.equal(daemonVersionOf({ ok: false, status: null }), null);
});

test('packaged shell: missing or different daemon version is stale (ROO-15)', () => {
  const facts = { packaged: true, home };
  // instance must match for isRooks — health helper uses instanceId(home) in
  // production; here we pass home undefined so identity alone is enough.
  const open = { packaged: true as const };
  assert.equal(daemonVersionStale(ours('0.1.0'), '0.2.0', open), true);
  assert.equal(daemonVersionStale(ours(), '0.2.0', open), true, 'pre-version health');
  assert.equal(daemonVersionStale(ours('0.2.0'), '0.2.0', open), false);
  assert.equal(daemonVersionStale(ours('0.2.0'), '0.2.0', { packaged: false }), false, 'dev never replaces');
  assert.equal(
    daemonVersionStale({ ok: true, status: 200, identity: 'foreign' }, '0.2.0', open),
    false,
  );
});

test('staleDaemonLog names both sides', () => {
  assert.match(staleDaemonLog(ours('0.1.9'), '0.2.0'), /0\.1\.9.*0\.2\.0/);
  assert.match(staleDaemonLog(ours(), '0.2.0'), /unknown/);
});
