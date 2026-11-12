/**
 * Password hashing for user accounts (Phase M.1).
 *
 * argon2id would be the usual choice, but it is not on the allowed
 * dependency list (`CLAUDE.md` rule 7). `scrypt` from `node:crypto` needs
 * nothing installed and is the recipe's fallback (`docs/MULTI-USER.md` §11).
 *
 * Encoding: `scrypt$N$r$p$<salt-b64url>$<key-b64url>`. The parameters travel
 * with the hash so a later cost bump does not invalidate existing rows.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;
const SALTLEN = 16;
/** ~16 MiB of memory, a few tens of ms on this machine — login, not a hot path. */
const N = 16_384;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordError';
  }
}

export function hashPassword(password: string): string {
  if (password.length === 0) throw new PasswordError('password must not be empty');
  const salt = randomBytes(SALTLEN);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** One-shot password for a superadmin reset. Shown once, communicated out of band. */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || r < 1 || p < 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let key: Buffer;
  try {
    key = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}
