/**
 * Second import of `boot.ts`, right after the log and BEFORE the home lock: the
 * lock is itself a SQLite file, and everything after it (restore, data update
 * routes, `db.ts`) opens databases or serves the home. The home is restricted
 * to the daemon's account first (TODO #864): on Windows a database or a
 * `-wal` / `-shm` created from here on inherits the owner-only ACL.
 *
 * Synchronous: an `await` here would not hold back the sibling imports that
 * follow (ES modules only wait for their own dependencies). Never fatal.
 * Daemon-only, like every `*-boot.ts`: a CLI runs beside a live daemon.
 *
 * Keep its import closure free of `db.ts` and `better-sqlite3`
 * (`home-permissions-boot.test.ts` checks it).
 */
import { mkdirSync } from 'node:fs';
import { hardenHomePermissions } from './home-permissions.js';
import { TIMON_HOME } from './paths.js';

try {
  mkdirSync(TIMON_HOME, { recursive: true, mode: 0o700 });
} catch (error) {
  console.warn(`[perms] cannot create ${TIMON_HOME}: ${(error as Error).message}`);
}
hardenHomePermissions(TIMON_HOME);
