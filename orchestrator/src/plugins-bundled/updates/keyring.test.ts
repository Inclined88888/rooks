import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyIdFor } from '../../../../scripts/release-manifest.mjs';
import { RELEASE_PUBLIC_KEYS, activeReleaseKeyring, overrideReleaseKeyringForTests } from './keyring.js';

test('every pinned keyId is the one the build machine derives from the key', () => {
  assert.ok(RELEASE_PUBLIC_KEYS.length > 0);
  for (const key of RELEASE_PUBLIC_KEYS) assert.equal(keyIdFor(key.publicKey), key.keyId);
});

test('the pinned keyring cannot be changed in place', () => {
  assert.ok(Object.isFrozen(RELEASE_PUBLIC_KEYS));
  for (const key of RELEASE_PUBLIC_KEYS) assert.ok(Object.isFrozen(key));
  assert.throws(() => { (RELEASE_PUBLIC_KEYS as unknown as unknown[]).push({ keyId: 'x', publicKey: 'y' }); });
});

test('a test keyring is copied and frozen, and goes away on null', () => {
  const keys = [{ keyId: 'release-test', publicKey: 'pem' }];
  overrideReleaseKeyringForTests(keys);
  keys[0]!.publicKey = 'changed';
  assert.equal(activeReleaseKeyring()[0]!.publicKey, 'pem');
  overrideReleaseKeyringForTests(null);
  assert.equal(activeReleaseKeyring(), RELEASE_PUBLIC_KEYS);
});
