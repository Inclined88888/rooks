/**
 * Which providers can really run on THIS machine — the question the first-run
 * setup asks before it lets anyone finish, and the one `doctor` reports.
 *
 * The core starts with no provider guaranteed (`docs/PROVIDERS-SDK.md` §12.2):
 * a profile is "active" when its credentials resolve, which says nothing about
 * the program it launches. A usable provider is an active profile that either
 * needs no process (a remote dialect) or whose executable resolves on this
 * host, through the same search `host.bin` does at spawn time. The pins the
 * wizard is about to write count: asking the person to pin a path and then
 * refusing because it is not yet in the file would be circular.
 */
import { resolvePinnedBinary, findExecutableBinary } from '../host/binary-path.js';
import { isRemoteDialect } from './types.js';
import { activeProfiles } from './registry.js';

export function usableProviders(pins: Readonly<Record<string, string>> = {}): string[] {
  const usable: string[] = [];
  for (const { profile, dialect, account } of activeProfiles()) {
    if (account) continue; // an account instance is its backend, counted once
    if (isRemoteDialect(dialect)) { usable.push(profile.id); continue; }
    const cmd = profile.cmd ?? dialect.defaultCmd;
    const pin = pins[cmd] ?? pins[profile.id];
    const found = pin ? resolvePinnedBinary(cmd, pin) : findExecutableBinary(cmd);
    if (found) usable.push(profile.id);
  }
  return usable;
}
