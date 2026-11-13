/**
 * Master key × OS keyring (S.2, `docs/SECRETS-VAULT.md` §4.2 and §4.4).
 *
 * A fake keyring throughout: the machine running the suite may have an unlocked
 * gnome-keyring, and a case that used it would pass here and prove nothing
 * about a server. The real `secret-tool` binding is covered — as far as it can
 * be — by `host/keyring.test.ts`.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SECRET_KEY_FILE, SECRET_KEY_LOCATION_FILE } from '../paths.js';
import type { Keyring } from '../host/types.js';
import { MASTER_KEY_BYTES, open, seal } from './box.js';
import { KEYRING_ACCOUNT, SecretKeyError, requireMasterKey, resetMasterKeyCache, resolveMasterKey } from './key.js';

type FakeKeyring = Keyring & { store: Map<string, string> };

function fakeKeyring(entries: Record<string, string> = {}, hooks: Partial<Keyring> = {}): FakeKeyring {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: hooks.get ?? ((account) => store.get(account)),
    set: hooks.set ?? ((account, value) => { store.set(account, value); }),
    del: hooks.del ?? ((account) => { store.delete(account); }),
  };
}

/** Blank home, cold cache — the location marker included. */
function clean(): void {
  resetMasterKeyCache();
  rmSync(SECRET_KEY_FILE, { recursive: true, force: true });
  rmSync(SECRET_KEY_LOCATION_FILE, { recursive: true, force: true });
}

/**
 * The same probe `recoverVaultRotation` uses: seal a row under `key`, then
 * ask whether a candidate opens it. Dual-location tests pass this in as
 * `opensWithWitness` so the decision in `key.ts` is exercised against real
 * GCM, not a stub that could lie.
 */
function witnessOf(key: Buffer): {
  hasEncryptedSecrets: () => boolean;
  opensWithWitness: (candidate: Buffer) => boolean;
} {
  const identity = { secretId: 'sec_witness', name: 'WITNESS' };
  const envelope = seal('v', key, identity);
  return {
    hasEncryptedSecrets: () => true,
    opensWithWitness: (candidate) => {
      try {
        open(envelope, candidate, identity);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function expectKeyError(fn: () => unknown, code: string): SecretKeyError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SecretKeyError, `expected a SecretKeyError, got ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  throw new Error(`expected a SecretKeyError \`${code}\`, nothing was thrown`);
}

test('first use with a working keyring: the key goes there, no file is written', () => {
  clean();
  const keyring = fakeKeyring();
  const key = resolveMasterKey({ keyring });
  assert.equal(key.length, MASTER_KEY_BYTES);
  assert.equal(keyring.store.get(KEYRING_ACCOUNT), key.toString('base64'));
  assert.equal(existsSync(SECRET_KEY_FILE), false);
  // The marker is what lets a later boot tell "keyring unreachable" from
  // "fresh install" — it is written only once the key is really stored.
  assert.equal(readFileSync(SECRET_KEY_LOCATION_FILE, 'utf8').trim(), 'keyring');
});

test('empty vault + two locations: the keyring survives, the file is dropped', () => {
  clean();
  const inKeyring = randomBytes(MASTER_KEY_BYTES);
  writeFileSync(SECRET_KEY_FILE, randomBytes(MASTER_KEY_BYTES).toString('base64'), { mode: 0o600 });
  const keyring = fakeKeyring({ [KEYRING_ACCOUNT]: inKeyring.toString('base64') });
  const said: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
  try {
    assert.deepEqual(resolveMasterKey({ keyring }), inKeyring);
  } finally {
    console.error = original;
  }
  assert.equal(existsSync(SECRET_KEY_FILE), false, 'the less durable location was kept');
  assert.equal(keyring.store.has(KEYRING_ACCOUNT), true);
  assert.ok(
    said.some((line) => line.includes('kept the keyring') && line.includes('dropped the file')),
    `expected a journal line, got: ${said.join(' | ')}`,
  );
});

test('a keyring value with a trailing newline is tolerated (secret-tool)', () => {
  clean();
  const key = randomBytes(MASTER_KEY_BYTES);
  const keyring = fakeKeyring({ [KEYRING_ACCOUNT]: `${key.toString('base64')}\n` });
  assert.deepEqual(resolveMasterKey({ keyring }), key);
});

test('keyring gone while it held the key → refusal, NOT a new key', () => {
  clean();
  // What a reboot into a locked session looks like: the marker says keyring,
  // the host exposes none, and there has never been a file.
  writeFileSync(SECRET_KEY_LOCATION_FILE, 'keyring\n', { mode: 0o600 });
  const err = expectKeyError(() => resolveMasterKey({ keyring: null }), 'keyring-unavailable');
  assert.match(err.message, /NEVER regenerated/);
  assert.equal(existsSync(SECRET_KEY_FILE), false);
  expectKeyError(() => requireMasterKey({ keyring: null }), 'keyring-unavailable');
});

test("switching `secrets.keyring` to 'off' after the fact is refused, and says so", () => {
  clean();
  // Seen from `key.ts`, `off` and "keyring out of reach" are the same state: no
  // keyring. Refusing is the right move — the key is there, it is merely no
  // longer reachable — but the message has to name the actual remedy.
  writeFileSync(SECRET_KEY_LOCATION_FILE, 'keyring\n', { mode: 0o600 });
  const err = expectKeyError(() => resolveMasterKey({ keyring: null }), 'keyring-unavailable');
  assert.match(err.message, /'off'/);
  assert.match(err.message, /'auto'/);
  assert.equal(existsSync(SECRET_KEY_FILE), false);
});

test('the entry vanished from the keyring while the marker names it → refusal', () => {
  clean();
  writeFileSync(SECRET_KEY_LOCATION_FILE, 'keyring\n', { mode: 0o600 });
  expectKeyError(() => resolveMasterKey({ keyring: fakeKeyring() }), 'keyring-unavailable');
  assert.equal(existsSync(SECRET_KEY_FILE), false);
});

test('a keyring that errors out is not an empty keyring', () => {
  clean();
  const keyring = fakeKeyring({}, {
    get() { throw new Error('the collection is locked'); },
  });
  const err = expectKeyError(() => resolveMasterKey({ keyring }), 'keyring-unavailable');
  assert.match(err.message, /locked/);
  assert.equal(existsSync(SECRET_KEY_FILE), false);
});

test('no keyring and no marker: the file takes over, said once', () => {
  clean();
  const said: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
  try {
    const key = resolveMasterKey({ keyring: null });
    resetMasterKeyCache();
    assert.deepEqual(resolveMasterKey({ keyring: null }), key);
  } finally {
    console.error = original;
  }
  assert.ok(existsSync(SECRET_KEY_FILE));
  // `resetMasterKeyCache` clears the log-once flag, so the second read speaks
  // again — but a single resolution never says it twice.
  assert.equal(said.filter((line) => line.includes('[secrets]')).length, 2);
  assert.ok(said[0]?.includes('no OS keyring available'), said[0]);
});

test('a keyring that refuses the write falls back to the file, without leaving a marker', () => {
  clean();
  const keyring = fakeKeyring({}, { set() { throw new Error('read-only collection'); } });
  const key = resolveMasterKey({ keyring });
  // Nothing was lost: no secret had ever been sealed with a key that failed to
  // be created, so the file simply takes over.
  assert.deepEqual(Buffer.from(readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'base64'), key);
  assert.equal(existsSync(SECRET_KEY_LOCATION_FILE), false);
});

test('a keyring that does not read back what it stored falls back to the file', () => {
  clean();
  const keyring = fakeKeyring({}, { set() { /* silently drops */ } });
  const key = resolveMasterKey({ keyring });
  assert.deepEqual(Buffer.from(readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'base64'), key);
  assert.equal(existsSync(SECRET_KEY_LOCATION_FILE), false);
});

/**
 * Hygiene around a `set()` that succeeded then failed to confirm. Cleanup is
 * still attempted — an orphan entry is worth removing when we can — but it is
 * no longer the line of defence: the next boot asks a sealed row which key is
 * live (§4.2). Each case still replays a boot.
 */

/** Makes the keyring store a valid but DIFFERENT key: the read-back disagrees,
 *  and there is a real entry left to clean up. */
function divergentSet(keyring: FakeKeyring): void {
  keyring.set = (account) => {
    keyring.store.set(account, randomBytes(MASTER_KEY_BYTES).toString('base64'));
  };
}

/**
 * The next boot, against the same home: the process cache goes, the files stay.
 * The fresh keyring must come back EMPTY at the end — that is what proves the
 * key was read from the file rather than minted anew on the spot.
 */
function expectRebootResolves(key: Buffer): void {
  resetMasterKeyCache();
  const nextBoot = fakeKeyring();
  assert.deepEqual(resolveMasterKey({ keyring: nextBoot }), key);
  assert.equal(nextBoot.store.has(KEYRING_ACCOUNT), false, 'the reboot minted a key instead of reading the file');
}

test('read-back disagrees: the keyring entry is removed, and a reboot finds the file key', () => {
  clean();
  const keyring = fakeKeyring();
  divergentSet(keyring);
  const key = resolveMasterKey({ keyring });

  // The stray entry is gone — otherwise it would shadow the file at next boot.
  assert.equal(keyring.store.has(KEYRING_ACCOUNT), false);
  assert.equal(existsSync(SECRET_KEY_LOCATION_FILE), false);
  assert.deepEqual(Buffer.from(readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'base64'), key);

  expectRebootResolves(key);
});

test('the marker cannot be written: the keyring entry is removed, and a reboot finds the file key', () => {
  clean();
  // A directory where the marker goes: `writeFileSync` fails with EISDIR, and
  // `markerSaysKeyring()` reads nothing — exactly the state to survive. It is
  // torn down in `finally`: left behind by a failing assertion, it would poison
  // every case added below this one.
  mkdirSync(SECRET_KEY_LOCATION_FILE, { recursive: true });
  try {
    const keyring = fakeKeyring();
    const key = resolveMasterKey({ keyring });

    assert.equal(keyring.store.has(KEYRING_ACCOUNT), false);
    assert.deepEqual(Buffer.from(readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'base64'), key);

    expectRebootResolves(key);
  } finally {
    clean();
  }
});

test('the stray keyring entry cannot be removed: boot still falls back to the file', () => {
  clean();
  const keyring = fakeKeyring({}, { del() { throw new Error('read-only collection'); } });
  divergentSet(keyring);
  const key = resolveMasterKey({ keyring });

  // Hygiene failed; the boot did not. A file key sits next to the orphan —
  // the next boot with a witness will tell them apart, instead of refusing.
  assert.equal(keyring.store.has(KEYRING_ACCOUNT), true);
  assert.deepEqual(Buffer.from(readFileSync(SECRET_KEY_FILE, 'utf8').trim(), 'base64'), key);
  assert.equal(existsSync(SECRET_KEY_LOCATION_FILE), false);
});

test('set() writes then throws: next boot, the witness picks the file key', () => {
  clean();
  const first = fakeKeyring();
  first.set = (account, value) => {
    first.store.set(account, value);
    throw new Error('timeout after write');
  };
  first.del = () => { throw new Error('bus gone'); };

  const fileKey = resolveMasterKey({ keyring: first });
  assert.ok(existsSync(SECRET_KEY_FILE));
  assert.equal(first.store.has(KEYRING_ACCOUNT), true, 'the orphan entry did not survive set()+timeout');

  resetMasterKeyCache();
  const next = fakeKeyring();
  for (const [account, value] of first.store) next.store.set(account, value);

  const resolved = resolveMasterKey({ keyring: next, ...witnessOf(fileKey) });
  assert.deepEqual(resolved, fileKey);
  assert.equal(next.store.has(KEYRING_ACCOUNT), false, 'the dead keyring entry was kept');
  assert.ok(existsSync(SECRET_KEY_FILE));
});

test('witness picks the file even when the dead keyring entry cannot be deleted', () => {
  clean();
  const fileKey = randomBytes(MASTER_KEY_BYTES);
  const dead = randomBytes(MASTER_KEY_BYTES);
  writeFileSync(SECRET_KEY_FILE, fileKey.toString('base64'), { mode: 0o600 });
  const keyring = fakeKeyring({ [KEYRING_ACCOUNT]: dead.toString('base64') }, {
    del() { throw new Error('read-only collection'); },
  });

  const resolved = resolveMasterKey({ keyring, ...witnessOf(fileKey) });
  assert.deepEqual(resolved, fileKey);
  // Hygiene failed; the boot did not — the vault is open.
  assert.equal(keyring.store.has(KEYRING_ACCOUNT), true);
  assert.ok(existsSync(SECRET_KEY_FILE));
});

test('the keyring sealed the vault: a stray file is dropped', () => {
  clean();
  const live = randomBytes(MASTER_KEY_BYTES);
  writeFileSync(SECRET_KEY_FILE, randomBytes(MASTER_KEY_BYTES).toString('base64'), { mode: 0o600 });
  const keyring = fakeKeyring({ [KEYRING_ACCOUNT]: live.toString('base64') });

  const resolved = resolveMasterKey({ keyring, ...witnessOf(live) });
  assert.deepEqual(resolved, live);
  assert.equal(existsSync(SECRET_KEY_FILE), false, 'the dead file key was kept');
  assert.equal(keyring.store.has(KEYRING_ACCOUNT), true);
});

test('neither key opens the witness: degraded, nothing written, nothing deleted', () => {
  clean();
  const inKeyring = randomBytes(MASTER_KEY_BYTES);
  const onFile = randomBytes(MASTER_KEY_BYTES);
  writeFileSync(SECRET_KEY_FILE, onFile.toString('base64'), { mode: 0o600 });
  const keyring = fakeKeyring({ [KEYRING_ACCOUNT]: inKeyring.toString('base64') });
  writeFileSync(SECRET_KEY_LOCATION_FILE, 'keyring\n', { mode: 0o600 });

  expectKeyError(
    () => resolveMasterKey({ keyring, ...witnessOf(randomBytes(MASTER_KEY_BYTES)) }),
    'unrecoverable',
  );

  assert.equal(keyring.store.get(KEYRING_ACCOUNT), inKeyring.toString('base64'));
  assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8').trim(), onFile.toString('base64'));
  assert.equal(readFileSync(SECRET_KEY_LOCATION_FILE, 'utf8').trim(), 'keyring');
});
