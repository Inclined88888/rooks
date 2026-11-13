import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  cleanDeviceName, deviceErrorKind, formatCountdown, reachableOutcome, secondsLeft, sortDevices, type PairedDevice,
} from './devices';
import { buildSettingsLayout, legacyGroupTarget } from './settings-layout';

function device(id: string, over: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id, user_id: 'u1', name: id, created_at: 0, last_seen_at: 0, last_ip: null, user_agent: null,
    revoked_at: null, expires_at: 1, status: 'active', current: false, ...over,
  };
}

test('the countdown never goes below zero and rounds up to the second', () => {
  assert.equal(secondsLeft(10_000, 0), 10);
  assert.equal(secondsLeft(10_000, 9_001), 1);
  assert.equal(secondsLeft(10_000, 10_000), 0);
  assert.equal(secondsLeft(10_000, 99_999), 0);
  assert.equal(formatCountdown(300), '5:00');
  assert.equal(formatCountdown(65), '1:05');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-4), '0:00');
});

test('a rename submits only what the daemon accepts', () => {
  assert.equal(cleanDeviceName('  Phone  '), 'Phone');
  assert.equal(cleanDeviceName('   '), null);
  assert.equal(cleanDeviceName('x'.repeat(65)), null);
  assert.equal(cleanDeviceName('x'.repeat(64)), 'x'.repeat(64));
  assert.equal(cleanDeviceName('tab\there'), null);
});

test('the device in use comes first, revoked ones last', () => {
  const ordered = sortDevices([
    device('revoked', { status: 'revoked', last_seen_at: 9 }),
    device('expired', { status: 'expired', last_seen_at: 8 }),
    device('older', { last_seen_at: 1 }),
    device('newer', { last_seen_at: 5 }),
    device('mine', { current: true, last_seen_at: 0 }),
  ]);
  assert.deepEqual(ordered.map((d) => d.id), ['mine', 'newer', 'older', 'expired', 'revoked']);
});

test('a refusal maps to a message, never to the daemon text', () => {
  assert.equal(deviceErrorKind({ status: 409, error: 'too_many_codes' }), 'tooManyCodes');
  // A device token, or a mission, asking for a code.
  assert.equal(deviceErrorKind({ status: 403, error: 'forbidden' }), 'notHere');
  assert.equal(deviceErrorKind({ status: 400, error: 'invalid_request' }), 'invalidName');
  assert.equal(deviceErrorKind({ status: 404, error: 'device not found' }), 'notFound');
  assert.equal(deviceErrorKind({ status: 401, error: 'unauthorized' }), 'generic');
  assert.equal(deviceErrorKind({ status: 502, error: null }), 'generic');
});

test('Devices is a native tab of Access & network, shown to every viewer', () => {
  const layout = buildSettingsLayout({
    rows: [], includeAdvanced: true, pluginStates: new Map(), pluginLabels: new Map(),
    plugins: [], graftedGroups: new Set(), desktop: false, secrets: false, superadmin: false,
  });
  const network = layout.find((category) => category.id === 'network');
  assert.ok(network);
  assert.deepEqual(network.tabs.find((tab) => tab.id === 'devices'), { id: 'devices', kind: 'native', pane: 'devices', grafts: [] });
  assert.deepEqual(legacyGroupTarget('devices'), { category: 'network', tab: 'devices' });
});

test('making the machine reachable: the address, or a typed failure with what to run', () => {
  assert.deepEqual(reachableOutcome(200, { address: 'https://box.tail1.ts.net:10000', port: 10000, reused: false }), {
    ok: true, address: 'https://box.tail1.ts.net:10000',
  });
  assert.deepEqual(
    reachableOutcome(409, { error: 'not_reachable', reason: 'permission', platform: 'linux', command: 'sudo tailscale serve --bg --https=443 http://127.0.0.1:3001', enable_url: null, detail: null }),
    { ok: false, reason: 'permission', platform: 'linux', command: 'sudo tailscale serve --bg --https=443 http://127.0.0.1:3001', enableUrl: null, detail: null },
  );
  const refused = reachableOutcome(403, { error: 'forbidden' });
  assert.equal(!refused.ok && refused.reason, 'notHere');
  // exit 0 without JSON (the macOS app bundle started as its GUI): typed, with what tailscale said.
  const unreadable = reachableOutcome(409, { reason: 'unreadable', platform: 'darwin', command: null, detail: 'The Tailscale GUI failed to start' });
  assert.equal(!unreadable.ok && unreadable.reason, 'unreadable');
  assert.equal(!unreadable.ok && unreadable.detail, 'The Tailscale GUI failed to start');
  const unknown = reachableOutcome(409, { reason: 'something_new' });
  assert.equal(!unknown.ok && unknown.reason, 'generic');
  // A 200 that is not an HTTPS address is not believed.
  assert.equal(reachableOutcome(200, { address: 'javascript:alert(1)' }).ok, false);
});

test('making the machine reachable: only the tailscale admin console is linked', () => {
  const linked = reachableOutcome(409, { reason: 'serve_disabled', enable_url: 'https://login.tailscale.com/f/serve?node=n1' });
  assert.equal(!linked.ok && linked.enableUrl, 'https://login.tailscale.com/f/serve?node=n1');
  const forged = reachableOutcome(409, { reason: 'serve_disabled', enable_url: 'javascript:alert(1)' });
  assert.equal(!forged.ok && forged.enableUrl, null);
});
