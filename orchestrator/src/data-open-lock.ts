/**
 * One packaged process at a time saves the pre-update copy and migrates the database.
 *
 * Once an update is approved, the daemon and a `rooks` of the package run from a terminal both
 * reach `protectDataBeforeOpen` and then the migrations of `db.ts`. Without this lock they each
 * wrote `backups/pre-<version>`, the second one possibly copying a database the first had already
 * migrated over the good copy, and both ran the same `ALTER TABLE`s.
 *
 * The lock is SQLite's own exclusive lock on `backups/data-open.lock`: `LockFileEx` on Windows,
 * `fcntl` elsewhere, the same locks that already guard `rooks.db`. The OS drops it when its
 * process dies, so a crash in the middle of a migration never leaves a lock to clear by hand.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backupsDir } from './data-version.js';

export const dataOpenLockFile = (home: string): string => join(backupsDir(home), 'data-open.lock');

/** A copy of a large database, plugins and every migration: long, but bounded by what a disk does. */
export const DATA_OPEN_LOCK_WAIT_MS = 15 * 60_000;

export class DataOpenLockTimeoutError extends Error {
  constructor(home: string, waitedMs: number) {
    super(
      `Another Rooks process has been saving and converting the data in ${home} for over `
      + `${Math.round(waitedMs / 60_000) || 1} minute(s). Nothing was changed by this one: `
      + 'try again once it has finished (rooks update status), or stop it and start Rooks again.',
    );
    this.name = 'DataOpenLockTimeoutError';
  }
}

const held = new Map<string, Database.Database>();

const isBusy = (error: unknown): boolean => /^SQLITE_(BUSY|LOCKED)/.test(String((error as { code?: unknown }).code ?? ''));

/**
 * Waits until no other process holds the lock, then holds it until `releaseDataOpenLock`
 * or the end of this process. Holding it already: returns at once.
 *
 * A lock that cannot be taken for another reason (a filesystem without locks) only warns:
 * refusing would keep Rooks from starting at all, for a race of a second.
 */
export function holdDataOpenLock(
  home: string,
  opts: { waitMs?: number; warn?: (message: string) => void } = {},
): void {
  const file = dataOpenLockFile(home);
  if (held.has(file)) return;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const waitMs = opts.waitMs ?? DATA_OPEN_LOCK_WAIT_MS;
  let lock: Database.Database | undefined;
  try {
    mkdirSync(backupsDir(home), { recursive: true, mode: 0o700 });
    lock = new Database(file, { timeout: 0 });
    try {
      lock.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (!isBusy(error)) throw error;
      warn('[data] another Rooks process is saving and converting your data; waiting for it to finish');
      lock.pragma(`busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
      try {
        lock.exec('BEGIN EXCLUSIVE');
      } catch (waited) {
        if (isBusy(waited)) throw new DataOpenLockTimeoutError(home, waitMs);
        throw waited;
      }
    }
    held.set(file, lock);
  } catch (error) {
    try { lock?.close(); } catch { /* Closing an unusable handle cannot make things worse. */ }
    if (error instanceof DataOpenLockTimeoutError) throw error;
    warn(`[data] could not lock the data before opening them (${(error as Error).message}); continuing without the lock`);
  }
}

/** Lets the next packaged process in. Not holding it: does nothing. */
export function releaseDataOpenLock(home: string): void {
  const file = dataOpenLockFile(home);
  const lock = held.get(file);
  if (!lock) return;
  held.delete(file);
  try { lock.exec('ROLLBACK'); } catch { /* Closing below releases it anyway. */ }
  lock.close();
}
