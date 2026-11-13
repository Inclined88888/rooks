import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { ROOKS_HOME, REMOTE_KEY_PATH } from '../paths';

/**
 * Lazily load (or create on first run) the local HMAC signing key.
 * Stored at ~/.rooks/remote-key with 0600 perms. Never committed.
 */
let cached: Buffer | null = null;

export function getSigningKey(): Buffer {
  if (cached) return cached;
  mkdirSync(ROOKS_HOME, { recursive: true });
  if (!existsSync(REMOTE_KEY_PATH)) {
    const key = randomBytes(32);
    mkdirSync(dirname(REMOTE_KEY_PATH), { recursive: true });
    writeFileSync(REMOTE_KEY_PATH, key);
    chmodSync(REMOTE_KEY_PATH, 0o600);
    cached = key;
    return key;
  }
  cached = readFileSync(REMOTE_KEY_PATH);
  return cached;
}
