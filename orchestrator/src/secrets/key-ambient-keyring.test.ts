/**
 * TODO #574: a suite that resolves the master key WITHOUT injecting
 * `keyring: null` must never reach the user's OS keyring. Its `timon` /
 * `master-key` entry is the installed daemon's: writing there would hand the
 * suite's key to the real install, and `key.ts` dropping the losing location
 * would delete the real key — every secret of the install lost.
 *
 * The user's Secret Service is played by a stand-in `secret-tool` on PATH,
 * already holding a "real" master key, with a session bus address set: the
 * conditions of a desktop Linux where the old code would have probed it.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const ambient = mkdtempSync(join(tmpdir(), 'timon-ambient-keyring-'));
writeFileSync(join(ambient, 'secret-tool'), [
  '#!/bin/sh',
  `state='${ambient}'`,
  'echo "$1" >> "$state/calls"',
  'exit 1',
].join('\n'), { mode: 0o755 });
const realKey = Buffer.alloc(32, 7).toString('base64');
writeFileSync(join(ambient, 'master-key'), realKey);

// Set before the host singleton is built: `getHost()` probes once, lazily.
process.env.PATH = `${ambient}${delimiter}${process.env.PATH ?? ''}`;
// The real bus address is kept when there is one: `systemctl --user` needs it,
// and without a user manager `getHost()` builds the generic host, which has no
// keyring to guard — the case would then pass without proving anything.
process.env.DBUS_SESSION_BUS_ADDRESS ||= 'unix:path=/nonexistent/timon-test-bus';

const { SECRET_KEY_FILE } = await import('../paths.js');
const { getHost } = await import('../host/index.js');
const { resetMasterKeyCache, resolveMasterKey } = await import('./key.js');

test('a key resolved with the host default never touches the ambient keyring', () => {
  resetMasterKeyCache();
  const key = resolveMasterKey();

  assert.equal(key.length, 32);
  assert.equal(getHost().keyring, undefined, 'the host must not expose the user keyring under the test runner');
  // The key went to the temporary home's file, not to the keyring.
  assert.equal(existsSync(SECRET_KEY_FILE), true);
  assert.equal(existsSync(join(ambient, 'calls')), false, 'the ambient secret-tool must never run');
  // And the install's own key is where it was, untouched.
  assert.equal(readFileSync(join(ambient, 'master-key'), 'utf8'), realKey);
});
