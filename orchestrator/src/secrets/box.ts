/**
 * Sealed envelope for secret values at rest (spec `docs/SECRETS-VAULT.md` §4.1).
 *
 * This module is the ONLY place in the codebase that knows the wire format:
 *
 *   enc:1:<iv b64>:<tag b64>:<ciphertext b64>
 *
 * `enc:1:` is a discriminator, not decoration. Anything that does not start
 * with it is a plaintext value inherited from before the vault existed, and
 * the `1` allows an algorithm rotation later without breaking existing rows.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENVELOPE_PREFIX = 'enc:1:';

/** AES-256-GCM: 32-byte key, 12-byte IV, 16-byte authentication tag. */
export const MASTER_KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Which row an envelope belongs to. Bound into the ciphertext as AAD. */
export type SecretIdentity = {
  /** Primary key of the `secrets` row (S.3). */
  secretId: string;
  /** Environment variable name, e.g. `GITHUB_TOKEN`. */
  name: string;
};

export type SecretBoxErrorCode =
  /** The string is not an `enc:1:` envelope, or its parts are malformed. */
  | 'bad-envelope'
  /** The key is not 32 bytes. */
  | 'bad-key'
  /** GCM rejected the tag: altered ciphertext, wrong key, or wrong identity. */
  | 'auth-failed';

export class SecretBoxError extends Error {
  constructor(readonly code: SecretBoxErrorCode, message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * Additional authenticated data: the row this value was sealed for.
 *
 * Without it, a blob copied from one row of `secrets` to another would decrypt
 * fine for the wrong recipient — encryption would stop someone from *reading*
 * the database, not from *replaying* its rows. `\0` cannot appear in either
 * field, so the concatenation is unambiguous.
 */
function aad(identity: SecretIdentity): Buffer {
  return Buffer.from(`${identity.secretId}\0${identity.name}`, 'utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new SecretBoxError('bad-key', `master key must be ${MASTER_KEY_BYTES} bytes, got ${key.length}`);
  }
}

/** True when the stored value is an envelope rather than a legacy plaintext. */
export function isSealed(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt `plain` for `identity`. A fresh random IV is drawn on EVERY call —
 * reusing one under the same key breaks GCM outright, so it is never derived
 * from the identity or from a counter.
 */
export function seal(plain: string, key: Buffer, identity: SecretIdentity): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENVELOPE_PREFIX
    + `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt an envelope sealed for `identity`. Throws `SecretBoxError` rather
 * than returning null: a failure here means tampering, a wrong key, or a row
 * that was moved — never something a caller should silently paper over.
 */
export function open(envelope: string, key: Buffer, identity: SecretIdentity): string {
  assertKey(key);
  if (!isSealed(envelope)) {
    throw new SecretBoxError('bad-envelope', `value is not an \`${ENVELOPE_PREFIX}\` envelope`);
  }
  const parts = envelope.slice(ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new SecretBoxError('bad-envelope', `envelope must carry 3 fields, got ${parts.length}`);
  }
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new SecretBoxError('bad-envelope', `IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new SecretBoxError('bad-envelope', `tag must be ${TAG_BYTES} bytes, got ${tag.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aad(identity));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM does not say *why* it refused: altered bytes, wrong key and wrong
    // identity are the same failure. Never leak anything about the plaintext.
    throw new SecretBoxError('auth-failed', 'authentication failed: altered value, wrong key, or wrong secret identity');
  }
}
