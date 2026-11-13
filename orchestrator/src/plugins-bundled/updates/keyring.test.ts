import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_PUBLIC_KEYS, activeReleaseKeyring, overrideReleaseKeyringForTests } from './keyring.js';

test('Rooks does not pin the previous product update key', () => {
  assert.equal(RELEASE_PUBLIC_KEYS.length, 0);
  assert.equal(RELEASE_PUBLIC_KEYS.some((key) => key.keyId === 'release-4253f18d5854243a'), false);
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
