/**
 * Read-only access to ONE entry of the operating system's credential store
 * (S4/S8 of `docs/PROVIDERS-SDK.md`): today the macOS login keychain, where a CLI
 * keeps the sign-in a file-based probe cannot see (TIM-0044 for `claude`). The
 * generalisation of `claude-keychain.ts`, for a provider that declared the entry in
 * its manifest.
 *
 * Read-only on purpose: refresh tokens rotate, so Timon refreshing a CLI's session
 * would invalidate the one the CLI holds. The value is returned to the caller and
 * never logged; a locked keychain or a refused prompt answers `null`, remembered
 * for a minute so that a gauge polling every few seconds does not stack prompts in
 * front of the user. Distinct from `Host.keyring`, which shelters Timon's own
 * master key.
 */
import type { Host } from './types.js';

const SECURITY_TIMEOUT_MS = 5_000;
const MISS_TTL_MS = 60_000;

export type OsCredentialEntry = { readonly service: string; readonly account?: string };

const misses = new Map<string, number>();
const keyOf = (entry: OsCredentialEntry): string => `${entry.service}\0${entry.account ?? ''}`;

/** Forget the remembered misses, so a login made since is picked up at once. */
export function resetOsCredentialMisses(entry?: OsCredentialEntry): void {
  if (entry) misses.delete(keyOf(entry));
  else misses.clear();
}

/**
 * The stored secret, or `null` when this is not macOS, the entry does not exist, or
 * the store cannot be read from this process (LaunchDaemon, SSH, locked, prompt
 * denied). Never throws: "cannot read" and "not signed in" are one answer.
 */
export function readOsCredential(
  host: Pick<Host, 'platform' | 'exec'>, entry: OsCredentialEntry, now: number = Date.now(),
): string | null {
  if (host.platform !== 'darwin') return null;
  const key = keyOf(entry);
  const lastMiss = misses.get(key);
  if (lastMiss && now - lastMiss < MISS_TTL_MS) return null;
  try {
    const args = ['find-generic-password', '-s', entry.service, ...(entry.account ? ['-a', entry.account] : []), '-w'];
    const result = host.exec('security', args, { timeout: SECURITY_TIMEOUT_MS });
    const value = result.stdout.trim();
    if (result.code === 0 && value) {
      misses.delete(key);
      return value;
    }
  } catch {
    // treated as a miss
  }
  misses.set(key, now);
  return null;
}
