/**
 * A daemon whose disk fails at every start must not be relaunched every few
 * seconds: TIM-0109 counted 4 718 systemd restarts on a `disk I/O error`, each
 * one writing to the journal of an already full disk. Imported by `boot.ts`
 * before the database exists, so nothing here may import `db.ts` or SQLite.
 */
import { statfsSync } from 'node:fs';

/** SQLite result codes (better-sqlite3 `SqliteError.code`) that name the storage, not the data. */
const SQLITE_STORAGE = /^SQLITE_(IOERR(_[A-Z_]+)?|FULL|CANTOPEN)$/;
/** errno codes of a disk that is full, read-only or failing. */
const ERRNO_STORAGE = new Set(['ENOSPC', 'EIO', 'EDQUOT', 'EROFS']);

/** How long a failed start waits before exiting, so any supervisor restarts it slowly. */
export const STORAGE_RETRY_DELAY_MS = 60_000;
/** Below this, `doctor` and the boot log warn: SQLite needs room for its WAL and snapshots. */
export const LOW_DISK_BYTES = 1024 ** 3;

export type StorageFailure = { code: string; message: string };

export function storageFailure(error: unknown): StorageFailure | null {
  if (!(error instanceof Error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code !== 'string') return null;
  return SQLITE_STORAGE.test(code) || ERRNO_STORAGE.has(code) ? { code, message: error.message } : null;
}

/** Free bytes for this user on the filesystem holding `dir`; null when the OS cannot tell. */
export function freeBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export function storageFailureMessage(
  failure: StorageFailure,
  files: { home: string; dbPath: string },
  free: number | null,
  delayMs: number,
): string {
  const space = free === null ? 'unknown' : formatBytes(free);
  return `[storage] Timon cannot use its data on disk (${failure.code}: ${failure.message}). `
    + `Database: ${files.dbPath}. Free space for ${files.home}: ${space}. `
    + 'Free some space or check the disk for errors in the system log; '
    + `the daemon stops and retries in ${Math.round(delayMs / 1000)} s.`;
}

export function lowDiskWarning(home: string, free: number | null): string | null {
  if (free === null || free >= LOW_DISK_BYTES) return null;
  return `[storage] Only ${formatBytes(free)} free for ${home}: the database may soon fail to write.`;
}

/**
 * Called on a boot that threw. Anything other than a storage failure returns
 * at once, for the caller to rethrow. A storage failure is logged with its
 * stack (catching it bypasses the `[fatal]` monitor of `log-file.ts`), then
 * the process waits and exits 1 — the supervisor's restart policy does the rest.
 */
export async function holdOnStorageFailure(
  error: unknown,
  files: { home: string; dbPath: string },
  deps: {
    delayMs?: number;
    log?: (line: string) => void;
    wait?: (ms: number) => Promise<void>;
    exit?: (code: number) => void;
    free?: (dir: string) => number | null;
  } = {},
): Promise<void> {
  const failure = storageFailure(error);
  if (!failure) return;
  const delayMs = deps.delayMs ?? STORAGE_RETRY_DELAY_MS;
  const log = deps.log ?? ((line: string) => console.error(line));
  log(storageFailureMessage(failure, files, (deps.free ?? freeBytes)(files.home), delayMs));
  if (error instanceof Error && error.stack) log(error.stack);
  await (deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(delayMs);
  (deps.exit ?? ((code: number) => process.exit(code)))(1);
}

/** Blocks the thread: nothing of a process in an undefined state may run meanwhile. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The same wait after the boot. A disk that fails once the daemon is up (a full
 * disk lets SQLite open, then refuses the first write) crashed it at once, and
 * the supervisor restarted it at its own pace — the boot's wait never applied.
 *
 * A listener for `uncaughtExceptionMonitor`, never `uncaughtException`: Node's
 * own fatal path is kept for every error, this only delays it on a storage
 * failure. The wait is synchronous on purpose: after an uncaught exception no
 * timer, dispatch or request may keep using a database that just failed.
 */
export function storageFailureMonitor(
  files: { home: string; dbPath: string },
  deps: {
    delayMs?: number;
    log?: (line: string) => void;
    sleep?: (ms: number) => void;
    free?: (dir: string) => number | null;
  } = {},
): (error: unknown) => void {
  let held = false;
  return (error: unknown) => {
    const failure = storageFailure(error);
    if (!failure || held) return;
    held = true;
    const delayMs = deps.delayMs ?? STORAGE_RETRY_DELAY_MS;
    (deps.log ?? ((line: string) => console.error(line)))(
      storageFailureMessage(failure, files, (deps.free ?? freeBytes)(files.home), delayMs),
    );
    (deps.sleep ?? sleepSync)(delayMs);
  };
}
