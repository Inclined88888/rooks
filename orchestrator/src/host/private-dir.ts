/**
 * A directory only the daemon's OS account may read: where a CLI keeps the
 * sign-in of one subscription account (`backends/accounts.ts`).
 *
 * POSIX: 0700 on the directory, 0600 on the files already in it. `mkdirSync`'s
 * `mode` goes through the umask and leaves an existing directory untouched, so
 * the mode is set again explicitly.
 *
 * Windows ignores these modes. The directory lives under `TIMON_HOME`, inside
 * the user profile, whose inherited ACL already shuts other accounts out; no
 * extra ACL is written here (to verify on a Windows machine).
 */
import { chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return dir;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // A file the CLI wrote with its own umask; sub-directories keep theirs.
    if (statSync(path).isFile()) chmodSync(path, 0o600);
  }
  return dir;
}
