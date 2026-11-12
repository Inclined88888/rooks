import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientOs, installersFor, visibleOffer, type UpdateArtifact, type UpdateOffer, type UpdateStatus } from './updates';

const artifact = (key: string): UpdateArtifact => {
  const [os, arch, format] = key.split('-') as [UpdateArtifact['os'], UpdateArtifact['arch'], UpdateArtifact['format']];
  return { key, os, arch, format, name: key, url: `https://example.com/${key}`, size: 1 };
};
const offer: UpdateOffer = {
  version: '0.1.8', publishedAt: '2026-11-10T09:00:00.000Z', notes: 'n', notesUrl: 'https://docs.rooks.local/changelog',
  artifacts: ['linux-x64-deb', 'linux-x64-appimage', 'linux-arm64-appimage', 'mac-arm64-dmg', 'mac-arm64-pkg', 'mac-x64-pkg', 'win-x64-nsis'].map(artifact),
};
const status = (state: UpdateStatus['state'], extra: Partial<UpdateStatus> = {}): UpdateStatus => ({
  installed: '0.1.6', channel: 'beta', enabled: true, state, checkedAt: null, available: state === 'available' ? offer : null,
  host: { os: 'linux', arch: 'x64' }, buildExpiresAt: null, ...extra,
});

test('the browser system is read from its user agent; a phone gets no installer', () => {
  assert.equal(clientOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Rooks/0.1.6 Electron/33'), 'linux');
  assert.equal(clientOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15'), 'mac');
  assert.equal(clientOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'win');
  assert.equal(clientOs('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile'), null);
  assert.equal(clientOs('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), null);
});

test('installers: the preferred format first, the daemon architecture on its own system', () => {
  assert.deepEqual(installersFor(offer, 'linux', { os: 'linux', arch: 'x64' }).map((a) => a.key), ['linux-x64-appimage', 'linux-arm64-appimage', 'linux-x64-deb']);
  assert.deepEqual(installersFor(offer, 'linux', { os: 'linux', arch: 'arm64' }).map((a) => a.key)[0], 'linux-arm64-appimage');
  // The .pkg installs the command line and the service: it goes before the .dmg.
  assert.deepEqual(installersFor(offer, 'mac', { os: 'mac', arch: 'arm64' }).map((a) => a.key), ['mac-arm64-pkg', 'mac-x64-pkg', 'mac-arm64-dmg']);
  // A browser on another system than the daemon: no architecture is assumed beyond x64 first.
  assert.equal(installersFor(offer, 'mac', { os: 'linux', arch: 'x64' })[0]?.key, 'mac-x64-pkg');
  assert.deepEqual(installersFor(offer, 'win', { os: 'linux', arch: 'x64' }).map((a) => a.key), ['win-x64-nsis']);
  assert.deepEqual(installersFor(offer, null, { os: 'linux', arch: 'x64' }), []);
});

test('an offer is shown only while available and not put off for that version', () => {
  assert.equal(visibleOffer({ status: status('available'), later: null, checking: false })?.version, '0.1.8');
  assert.equal(visibleOffer({ status: status('available'), later: '0.1.8', checking: false }), null);
  assert.equal(visibleOffer({ status: status('available'), later: '0.1.7', checking: false })?.version, '0.1.8', 'a newer version comes back after Later');
  for (const state of ['off', 'dev', 'unchecked', 'up_to_date', 'failed'] as const) {
    assert.equal(visibleOffer({ status: status(state, { available: offer }), later: null, checking: false }), null, state);
  }
  assert.equal(visibleOffer({ status: null, later: null, checking: false }), null);
});
