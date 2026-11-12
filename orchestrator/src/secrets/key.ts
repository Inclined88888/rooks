/**
 * Master key of the secrets vault (`docs/SECRETS-VAULT.md` §4.2 and §4.4).
 *
 * Two locations: the OS keyring (service `rooks`, account `master-key`) when
 * the host exposes one, and the file fallback `~/.rooks/secret-key`, base64,
 * mode `0600`, in `ZONES.secrets` so no export ever carries it. The file is
 * the NORMAL path, not a degradation: the Secret Service is locked as long as
 * no graphical session is unlocked and does not exist at all on a server.
 *
 * When both locations hold a key, the choice is by **verification**, not
 * priority — the same reasoning as `recoverVaultRotation` (§4.5). A sealed
 * row is the witness: whichever candidate opens it is live, the other is
 * dropped. Neither opens → degraded mode, nothing written, nothing deleted.
 * Empty vault (no witness): keep the more durable location (the keyring if
 * it answers) and drop the other. A `set()` that writes then throws can
 * leave an orphan entry; the witness makes that harmless.
 *
 * The rule that shapes this whole module: **an unreadable master key is never
 * regenerated.** `readOrCreateTokenKey()` (`plugins/context.ts`) does exactly
 * that, and it is right to — it protects ephemeral UI tokens, whose loss costs
 * a re-login. Here the same reflex would turn a transient read failure (a mount
 * not ready yet, permissions damaged, a locked keyring) into the permanent loss
 * of every secret, silently. So creation happens only when we are sure there is
 * nothing to lose: no key anywhere AND no encrypted secret in the database.
 * Every other failure throws without writing a single byte.
 *
 * That rule is what forces the location marker: a keyring that becomes
 * unreachable after having held the key (session locked at reboot, D-Bus gone)
 * is indistinguishable from a fresh install — same empty keyring, same missing
 * file. The marker makes the difference explicit, and turns what would be a
 * silent regeneration into a loud refusal.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PENDING_SECRET_KEY_FILE, SECRET_KEY_FILE, SECRET_KEY_LOCATION_FILE, ROOKS_HOME } from '../paths.js';
import { getHost } from '../host/index.js';
import type { Keyring } from '../host/types.js';
import { MASTER_KEY_BYTES } from './box.js';

/** Account name under the `rooks` service (SECRETS-VAULT §4.2). */
export const KEYRING_ACCOUNT = 'master-key';

export type SecretKeyErrorCode =
  /** The key file exists but could not be read (permissions, I/O, a directory…). */
  | 'unreadable'
  /** The key file was read but does not hold 32 base64 bytes. */
  | 'malformed'
  /** The key file is readable by someone other than its owner. */
  | 'insecure-mode'
  /** No key anywhere, and creating one would orphan existing encrypted secrets. */
  | 'would-orphan'
  /** No key anywhere and the caller asked for a read-only resolution. */
  | 'absent'
  /** The key was stored in the OS keyring, which no longer answers. */
  | 'keyring-unavailable'
  /** Both locations hold a key and neither opens the sealed witness. */
  | 'unrecoverable'
  /** The new key could not be written. */
  | 'write-failed';

export class SecretKeyError extends Error {
  constructor(readonly code: SecretKeyErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

export type MasterKeyOptions = {
  /**
   * Whether the database already holds encrypted values. Creating a key while
   * this is true would make them permanently undecipherable, so it is refused.
   *
   * Default `false`: at S.1 the `secrets` table does not exist yet. S.3 wires
   * the real query in.
   */
  hasEncryptedSecrets?: () => boolean;
  /**
   * Keyring to use, `null` for none. Left out, the host decides — which is what
   * the daemon wants and what a test never wants: the machine running the suite
   * may well have an unlocked keyring, and the result would depend on it. The
   * Linux host refuses that ambient keyring under the test runner (TODO #574),
   * but a test about the file path still says `null` rather than lean on it.
   */
  keyring?: Keyring | null;
  /**
   * Probe a sealed vault row with a candidate key. Same reasoning as
   * `recoverVaultRotation` (§4.5): when two locations hold a key, the data
   * say which one sealed the vault. Production (`vaultKey`) passes the store's
   * witness helper; tests pass `box.open` against an envelope they sealed.
   */
  opensWithWitness?: (key: Buffer) => boolean;
};

let cached: Buffer | null = null;
let fallbackLogged = false;

/** Test seam: `paths.ts` freezes at import, the cache must not outlive a case. */
export function resetMasterKeyCache(): void {
  cached = null;
  fallbackLogged = false;
}

function keyringOf(opts: MasterKeyOptions): Keyring | undefined {
  if (opts.keyring !== undefined) return opts.keyring ?? undefined;
  // The host is built from the config, which may not be loadable in every
  // context that touches a key; no keyring is always a valid answer.
  try { return getHost().keyring; } catch { return undefined; }
}

/**
 * Read-only view of the keyring master key. Rotation recovery uses this
 * instead of `pickLiveKey`: dropping a live location while a pending
 * candidate is still on disk would leave the vault with one key and a
 * candidate that might be the one the rows are under.
 *
 * `null` when there is no keyring, it does not answer, or it holds
 * nothing. Never writes, never consults the location marker. Inject a
 * keyring through `MasterKeyOptions` (same seam as `resolveMasterKey`);
 * omitted, the host decides, and `getHost()` is wrapped like `keyringOf`.
 */
export function readKeyringMasterKey(opts: MasterKeyOptions = {}): Buffer | null {
  const keyring = keyringOf(opts);
  if (!keyring) return null;
  let raw: string | undefined;
  try {
    raw = keyring.get(KEYRING_ACCOUNT);
  } catch {
    return null;
  }
  if (raw === undefined) return null;
  return decodeKey(raw);
}

/** Said once per process. The file is the expected path on a server, so this is
 *  a trace, not a warning — and it must not repeat on every read. */
function logFileFallbackOnce(keyring: Keyring | undefined): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  const why = keyring ? 'OS keyring holds no master key' : 'no OS keyring available';
  console.error(`[secrets] ${why} — master key in ${SECRET_KEY_FILE}`);
}

function markerSaysKeyring(): boolean {
  try {
    return readFileSync(SECRET_KEY_LOCATION_FILE, 'utf8').trim() === 'keyring';
  } catch {
    // Marker unreadable or absent: the file fallback stays the assumption. A
    // missing marker cannot claim a key exists somewhere.
    return false;
  }
}

type KeyringRead =
  | { kind: 'key'; key: Buffer }
  | { kind: 'empty' }
  | { kind: 'error'; error: SecretKeyError };

/**
 * Read the key from the OS keyring without deciding yet. An error here is not
 * thrown immediately: if a file key sits next to it, the witness (or the file
 * itself) still has a chance. Thrown only when that is the only candidate.
 */
function readKeyringSoft(keyring: Keyring | undefined): KeyringRead {
  if (!keyring) {
    if (!markerSaysKeyring()) return { kind: 'empty' };
    return {
      kind: 'error',
      error: new SecretKeyError(
        'keyring-unavailable',
        'the master key lives in the OS keyring, and this process has none: either it cannot '
        + "reach it (locked session, no D-Bus…), or `secrets.keyring` was set to 'off' after the "
        + "key was stored there — in which case put it back to 'auto'. The key is NEVER "
        + `regenerated: unlock the keyring, or restore ${SECRET_KEY_FILE} from a backup.`,
      ),
    };
  }
  let raw: string | undefined;
  try {
    raw = keyring.get(KEYRING_ACCOUNT);
  } catch (e) {
    return {
      kind: 'error',
      error: new SecretKeyError(
        'keyring-unavailable',
        `the OS keyring refused to answer for "${KEYRING_ACCOUNT}" (${String(e)}). `
        + 'The master key is NEVER regenerated.',
        e,
      ),
    };
  }
  if (raw === undefined) {
    if (!markerSaysKeyring()) return { kind: 'empty' };
    return {
      kind: 'error',
      error: new SecretKeyError(
        'keyring-unavailable',
        `"${KEYRING_ACCOUNT}" has disappeared from the OS keyring while the marker says it was stored there. `
        + 'Restore it rather than starting over: a new key would orphan every secret.',
      ),
    };
  }
  return { kind: 'key', key: decodeKey(raw) };
}

function writeKeyringMarker(): void {
  mkdirSync(ROOKS_HOME, { recursive: true });
  writeFileSync(SECRET_KEY_LOCATION_FILE, 'keyring\n', { mode: 0o600 });
}

function dropFileKey(): void {
  rmSync(SECRET_KEY_FILE, { force: true });
}

/** Hygiene: a failed delete does not fail the boot — the witness already told. */
function dropKeyringKey(keyring: Keyring | undefined): void {
  if (keyring) {
    try {
      keyring.del(KEYRING_ACCOUNT);
    } catch (e) {
      console.error(
        `[secrets] could not remove the dead OS keyring entry "${KEYRING_ACCOUNT}" (${String(e)})`,
      );
    }
  }
  rmSync(SECRET_KEY_LOCATION_FILE, { force: true });
}

/**
 * Two locations hold a key. Same table as `recoverVaultRotation` (§4.5): ask
 * a sealed row which candidate is live. Actions differ (drop the other
 * location vs. promote/discard a pending file) because the candidates do.
 */
function pickLiveKey(
  keyringKey: Buffer,
  fileKey: Buffer,
  keyring: Keyring | undefined,
  opts: MasterKeyOptions,
): Buffer {
  const hasWitness = opts.hasEncryptedSecrets?.() === true;
  if (!hasWitness) {
    dropFileKey();
    writeKeyringMarker();
    console.error(
      '[secrets] empty vault held a master key in both the OS keyring and the file; '
      + 'kept the keyring, dropped the file',
    );
    return keyringKey;
  }
  const opens = opts.opensWithWitness;
  if (!opens) {
    throw new SecretKeyError(
      'unrecoverable',
      'both the OS keyring and the file hold a master key, and no sealed row was given to tell them apart. '
      + 'Nothing has been written or deleted.',
    );
  }
  const keyringOpens = opens(keyringKey);
  const fileOpens = opens(fileKey);
  if (keyringOpens) {
    dropFileKey();
    writeKeyringMarker();
    console.error(
      '[secrets] dropped a dead file master key; the OS keyring is the one that sealed the vault',
    );
    return keyringKey;
  }
  if (fileOpens) {
    dropKeyringKey(keyring);
    logFileFallbackOnce(keyring);
    console.error(
      '[secrets] dropped a dead OS keyring master key; the file is the one that sealed the vault',
    );
    return fileKey;
  }
  throw new SecretKeyError(
    'unrecoverable',
    'neither the OS keyring key nor the file key opens the stored secrets. '
    + 'Nothing has been written or deleted (§4.4: a key is never regenerated). Restore a key from a backup.',
  );
}

function adopt(key: Buffer): Buffer {
  cached = key;
  return key;
}

/** Existing key, or `null` when both locations are empty. Throws on hard failures. */
function resolveExisting(opts: MasterKeyOptions): Buffer | null {
  const keyring = keyringOf(opts);
  const kr = readKeyringSoft(keyring);
  const file = readMasterKey();
  if (kr.kind === 'key' && file) return adopt(pickLiveKey(kr.key, file, keyring, opts));
  if (kr.kind === 'key') return adopt(kr.key);
  if (file) {
    logFileFallbackOnce(keyring);
    return adopt(file);
  }
  if (kr.kind === 'error') throw kr.error;
  return null;
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // `Buffer.from(…, 'base64')` silently drops anything it does not understand:
  // a truncated or corrupted file would decode to a short key instead of an
  // error. Validate the alphabet first, then the decoded length.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new SecretKeyError('malformed', `${SECRET_KEY_FILE} is not valid base64`);
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== MASTER_KEY_BYTES) {
    throw new SecretKeyError(
      'malformed',
      `${SECRET_KEY_FILE} holds ${key.length} bytes, expected ${MASTER_KEY_BYTES}`,
    );
  }
  return key;
}

/**
 * Refuse a key file any account but its owner can read, BEFORE its bytes are
 * used for anything (§4.2).
 *
 * Deliberately a refusal and not a repair: `chmod 600` here would silently
 * absorb the one signal that the key spent time exposed — a stray `umask 0`, a
 * restore from an archive that flattened modes, a copy onto a share. The
 * operator has to know, because the right answer is often to rotate, not to
 * tighten. Windows has no POSIX mode bits, so the check does not apply there.
 */
function assertOwnerOnly(file: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) === 0) return;
  throw new SecretKeyError(
    'insecure-mode',
    `${file} is mode ${mode.toString(8).padStart(4, '0')}: readable beyond its owner. `
    + 'The master key opens every secret in the vault. Restrict it (chmod 600) and, since it '
    + 'may have been read, rotate it with `rooks secret rekey`.',
  );
}

function readKeyFile(file: string): Buffer | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SecretKeyError(
      'unreadable',
      `${file} exists but cannot be read (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}). `
      + 'The master key is NEVER regenerated: fix the file or restore it from a backup.',
      e,
    );
  }
  // Order matters: the mode is checked before the bytes are decoded, so an
  // exposed key is reported as exposed rather than as whatever else is wrong.
  assertOwnerOnly(file);
  return decodeKey(raw);
}

/**
 * Read the key from its file. Returns `null` — and only then — when the file
 * does not exist. Any other failure throws: the difference between "there is
 * nothing" and "I cannot read it" is the whole point of §4.4.
 */
export function readMasterKey(): Buffer | null {
  return readKeyFile(SECRET_KEY_FILE);
}

/**
 * The key a rotation staged but has not promoted yet (§4.5).
 *
 * `null` when no rotation is in flight. A non-null value means the process
 * died somewhere inside `rekeyVault`, and the caller — `recoverVaultRotation`
 * in `store.ts`, the only one that can probe the rows — has to decide which of
 * the two keys the database is now sealed with.
 */
export function readPendingKey(): Buffer | null {
  return readKeyFile(PENDING_SECRET_KEY_FILE);
}

/** Stage the rotated key on disk BEFORE the rows are committed to it. */
export function writePendingKey(key: Buffer): void {
  try {
    mkdirSync(ROOKS_HOME, { recursive: true });
    writeFileSync(PENDING_SECRET_KEY_FILE, key.toString('base64'), { mode: 0o600 });
  } catch (e) {
    throw new SecretKeyError('write-failed', `cannot write ${PENDING_SECRET_KEY_FILE}: ${String(e)}`, e);
  }
  try { chmodSync(PENDING_SECRET_KEY_FILE, 0o600); } catch { /* nothing to enforce there */ }
}

/** Drop a staged key: the rotation aborted before the rows moved. */
export function clearPendingKey(): void {
  rmSync(PENDING_SECRET_KEY_FILE, { force: true });
}

/**
 * Promote the staged key to the real one, atomically.
 *
 * `rename` rather than a write: `writeFileSync` truncates first, so dying
 * inside it would leave a half-written key file — a vault that no longer opens
 * AND no intact copy to fall back on. A rename either happened or did not.
 */
export function promotePendingKey(): Buffer {
  const pending = readPendingKey();
  if (!pending) throw new SecretKeyError('absent', `${PENDING_SECRET_KEY_FILE} does not exist`);
  try {
    renameSync(PENDING_SECRET_KEY_FILE, SECRET_KEY_FILE);
  } catch (e) {
    throw new SecretKeyError('write-failed', `cannot promote ${PENDING_SECRET_KEY_FILE}: ${String(e)}`, e);
  }
  cached = pending;
  return pending;
}

/**
 * Store a fresh key in the keyring. Order matters: write, read back, and only
 * then drop the marker — a marker written in front of a failed write would hard
 * block the next boot with no key anywhere.
 *
 * `null` means "fall back to the file". Cleanup of a half-written entry is
 * hygiene, not the line of defence: `set()` can store then throw (timeout
 * after D-Bus), and a `del()` that then fails used to abort the boot. The
 * witness of §4.2 makes two leftover keys harmless — the next boot asks a
 * sealed row which one is live — so a failed cleanup no longer refuses to
 * start. We still try.
 */
function createKeyringKey(keyring: Keyring): Buffer | null {
  const key = randomBytes(MASTER_KEY_BYTES);
  const encoded = key.toString('base64');
  try {
    keyring.set(KEYRING_ACCOUNT, encoded);
  } catch {
    // May have stored then thrown. Best-effort cleanup; the witness will
    // tell them apart if an orphan survives next to the file fallback.
    try { keyring.del(KEYRING_ACCOUNT); } catch { /* next boot's witness */ }
    return null;
  }
  try {
    if (keyring.get(KEYRING_ACCOUNT)?.trim() !== encoded) {
      throw new Error('the keyring did not read back the key it had just been given');
    }
    writeKeyringMarker();
    return key;
  } catch {
    try { keyring.del(KEYRING_ACCOUNT); } catch {
      console.error(
        `[secrets] could not remove a half-written "${KEYRING_ACCOUNT}" entry; `
        + 'falling back to the file. The next boot will ask a sealed row which key is live.',
      );
    }
    return null;
  }
}

function createMasterKey(): Buffer {
  const key = randomBytes(MASTER_KEY_BYTES);
  try {
    mkdirSync(ROOKS_HOME, { recursive: true });
    // `wx` refuses an existing file: between the read above and here, another
    // process may have created the key. Losing that race must not overwrite it.
    writeFileSync(SECRET_KEY_FILE, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    throw new SecretKeyError('write-failed', `cannot write ${SECRET_KEY_FILE}: ${String(e)}`, e);
  }
  // Best-effort: `mode` is ignored by filesystems without permissions.
  try { chmodSync(SECRET_KEY_FILE, 0o600); } catch { /* nothing to enforce there */ }
  return key;
}

/**
 * The daemon's entry point: read the key, creating one only on a genuinely
 * empty install. Throws `SecretKeyError` in every other failure — the caller
 * (S.3 onwards) then starts in degraded mode, flags the secrets as unavailable
 * and raises an alert, rather than silently starting over with a fresh key.
 */
export function resolveMasterKey(opts: MasterKeyOptions = {}): Buffer {
  if (cached) return cached;
  const existing = resolveExisting(opts);
  if (existing) return existing;
  if (opts.hasEncryptedSecrets?.() === true) {
    throw new SecretKeyError(
      'would-orphan',
      `${SECRET_KEY_FILE} is missing while encrypted secrets exist. `
      + 'Creating a key now would make them undecipherable forever: restore the key instead.',
    );
  }
  const keyring = keyringOf(opts);
  if (keyring) {
    const created = createKeyringKey(keyring);
    if (created) return adopt(created);
  }
  logFileFallbackOnce(keyring);
  return adopt(createMasterKey());
}

/** Read-only resolution, for callers that must not create anything. */
export function requireMasterKey(opts: MasterKeyOptions = {}): Buffer {
  if (cached) return cached;
  const key = resolveExisting(opts);
  if (!key) throw new SecretKeyError('absent', `no master key in the OS keyring nor in ${SECRET_KEY_FILE}`);
  return key;
}
