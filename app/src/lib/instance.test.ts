/**
 * The DEV instance must be visible, and it must stay confined to the machine
 * that asked for it.
 *
 * Two failures are guarded here. The obvious one: a development window that
 * looks exactly like the product, which is what this feature exists to fix.
 * The dangerous one: a release that inherits the development name because a
 * value travelled where it should not — a stale variable, a typo, a build
 * artefact. Every unexpected input therefore resolves to the product identity.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { instanceIdentity, resolveInstanceVariant, RELEASE_INSTANCE } from './instance';

test('an explicit dev instance renames and re-badges every surface', () => {
  const dev = instanceIdentity({ ROOKS_INSTANCE: 'dev' });
  assert.equal(dev.variant, 'dev');
  assert.equal(dev.displayName, 'Rooks DEV');
  assert.equal(dev.shortName, 'Rooks DEV');
  assert.ok(dev.fullName.includes('DEV'), 'the window title must carry the marker too');
  assert.equal(dev.badge, 'DEV');
  // Distinct artwork, or the home screen still shows two identical icons.
  assert.notEqual(dev.icons.small, RELEASE_INSTANCE.icons.small);
  assert.notEqual(dev.icons.large, RELEASE_INSTANCE.icons.large);
  assert.notEqual(dev.icons.apple, RELEASE_INSTANCE.icons.apple);
  assert.notEqual(dev.icons.vector, RELEASE_INSTANCE.icons.vector);
  assert.notEqual(dev.logo.color, RELEASE_INSTANCE.logo.color, 'the development mark has a colour of its own');
});

test('the product identity carries no marker at all', () => {
  const release = instanceIdentity({});
  assert.equal(release.variant, 'release');
  assert.equal(release.displayName, 'Rooks');
  // The long name is what the window title and the PWA advertise. `Rooks`
  // alone stays the SHORT label (logotype alt, navigation, launcher tile) and
  // is also the electron-builder `productName`, which must never grow spaces.
  assert.equal(release.fullName, 'Rooks');
  assert.equal(release.shortName, 'Rooks');
  assert.equal(release.badge, null);
  assert.equal(release.icons.small, '/icon-192.png');
  assert.equal(release.logo.color, 'hsl(var(--primary))', 'the product mark follows the theme');
});

test('anything that is not exactly "dev" degrades to the product', () => {
  for (const value of [undefined, '', '   ', 'release', 'prod', 'development', 'devel', '0', 'false', 'dev-vps']) {
    assert.equal(
      resolveInstanceVariant({ ROOKS_INSTANCE: value }),
      'release',
      `ROOKS_INSTANCE=${JSON.stringify(value)} must not brand a window DEV`,
    );
  }
});

test('the value is read loosely enough to survive a shell', () => {
  // Quoting and case are the two things a compose file or an export mangles;
  // neither should silently disable the marker the maintainer relies on.
  for (const value of ['dev', 'DEV', 'Dev', ' dev ', '\tdev\n']) {
    assert.equal(resolveInstanceVariant({ ROOKS_INSTANCE: value }), 'dev');
  }
});

test('the fallback identity used outside the provider is the product', () => {
  // A client component rendered without the provider — a plugin mounting the
  // logotype on its own — must not paint a DEV badge in a customer's window.
  assert.equal(RELEASE_INSTANCE.variant, 'release');
  assert.equal(RELEASE_INSTANCE.badge, null);
});

test('every path an identity advertises actually exists in public/', () => {
  // A typo here is a 404 on the home-screen icon — silent, and only visible
  // once the PWA is installed.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
  for (const identity of [RELEASE_INSTANCE, instanceIdentity({ ROOKS_INSTANCE: 'dev' })]) {
    for (const path of Object.values(identity.icons)) {
      assert.ok(existsSync(join(publicDir, path)), `${path} is referenced but missing`);
    }
  }
});

test('the installed PWA carries the instance name and its own artwork', async () => {
  // The manifest is what a launcher remembers: get this wrong and the two
  // instances share a tile forever, whatever the rest of the UI says.
  const { default: manifest } = await import('../app/manifest');
  const previous = process.env.ROOKS_INSTANCE;
  try {
    process.env.ROOKS_INSTANCE = 'dev';
    const dev = manifest();
    assert.equal(dev.short_name, 'Rooks DEV');
    assert.ok(dev.name?.includes('DEV'));
    assert.deepEqual(dev.icons?.map((i) => i.src), ['/icon-dev-192.png', '/icon-dev-512.png', '/icon-dev.svg']);

    delete process.env.ROOKS_INSTANCE;
    const release = manifest();
    assert.equal(release.short_name, 'Rooks');
    assert.equal(release.name, 'Rooks');
    assert.deepEqual(release.icons?.map((i) => i.src), ['/icon-192.png', '/icon-512.png', '/icon.svg']);
  } finally {
    if (previous === undefined) delete process.env.ROOKS_INSTANCE;
    else process.env.ROOKS_INSTANCE = previous;
  }
});
