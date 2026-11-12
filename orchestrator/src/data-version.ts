/**
 * What a tester needs to go back to the version they had before an update.
 *
 * After explicit approval, the first time a version opens existing data it keeps a copy of the
 * database, the integrations database, configuration and third-party plugin directories in `backups/pre-<version>/`, BEFORE any
 * migration ran, and records itself in `data-version`. An older version
 * reinstalled later reads that file: the desktop then offers to put the copy
 * back, and only a click writes `backups/restore-request.json`, which the
 * daemon of that exact version applies at its next boot, before the database
 * is opened.
 *
 * Only packaged daemons (desktop embedded or desktop service) do any of this.
 * A headless operator can approve through the CLI; a source checkout does not
 * copy its whole database at every version bump.
 *
 * Nothing here writes outside `backups/`, `data-version` and `update-approval.json`, except the
 * restore itself, which the user asked for.
 *
 * A version that cannot save its copy does not start when it would rewrite
 * data an older version needs (a migration declared in
 * `DESTRUCTIVE_MIGRATIONS`); additive migrations only warn, since the older
 * version still opens what they leave. A restore either replaces the database, the integrations
 * database, the configuration, plugin directories and `data-version` together, or leaves them as they were.
 */
import Database from 'better-sqlite3';
import {
  copyFileSync,
  lstatSync,
  readlinkSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { copyLink, copyTree } from './tree-copy.js';
import { packagedRuntime } from './host/bundled-node.js';
import { tightenToOwner } from './host/owner-only.js';
import { LEGACY_ACCOUNT_TABLES, legacyAccountTablesPresent } from './users/legacy-account-tables.js';

export { copyLink };

/** How many `pre-<version>` copies survive; older ones are deleted. */
export const KEPT_SNAPSHOTS = 3;
/** Exit code a running daemon uses to have its supervisor restart it into a restore. */
export const RESTORE_EXIT_CODE = 75;

export const dataVersionFile = (home: string): string => join(home, 'data-version');
export const backupsDir = (home: string): string => join(home, 'backups');
export const restoreRequestFile = (home: string): string => join(backupsDir(home), 'restore-request.json');
export const lastRestoreFile = (home: string): string => join(backupsDir(home), 'last-restore.json');
export const snapshotFailureFile = (home: string): string => join(backupsDir(home), 'snapshot-failure.json');
const restoreJournalFile = (home: string): string => join(backupsDir(home), 'restore-journal.json');
export const snapshotName = (version: string): string =>
  `pre-${version.trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'unknown'}`;

const SNAPSHOT_NAME = /^pre-[A-Za-z0-9._-]{1,48}$/;
const BEFORE_RESTORE = 'before-restore';

type PluginSlot = 'plugins' | 'plugins-data';
type PluginCopy = { state: 'absent' } | { state: 'saved'; digest: string } | { state: 'omitted' };
/**
 * Connections per user and messaging receipts (deduplication keys,
 * checkpoints) live in their own SQLite file next to `rooks.db`
 * (`plugins/integration-runtime.ts`). The name is repeated rather than
 * imported: this module must not load `paths.ts` and its home guard.
 */
const INTEGRATIONS_DB = 'integrations.db';
const integrationsDbPath = (files: DataFiles): string => join(files.home, INTEGRATIONS_DB);
/** Absence is distinct from an omitted plugin copy or legacy metadata. `integrations` is missing
 *  from a copy written before it was saved: a restore then leaves the live file alone. */
export type SnapshotMeta = { from: string | null; to: string; createdAt: number; config?: boolean;
  pluginCopies?: Record<PluginSlot, PluginCopy>; integrations?: 'saved' | 'absent'; partial?: string };
export const MAX_PLUGIN_BACKUP_BYTES = 1024 ** 3;
const MAX_PLUGIN_BACKUP_ENTRIES = 100_000;
const PLUGIN_SLOTS: readonly PluginSlot[] = ['plugins', 'plugins-data'];
export const snapshotProgressFile = (home: string): string => join(backupsDir(home), 'snapshot-progress.json');
export type SnapshotProgress = { version: string; phase: 'scanning' | 'database' | 'plugins' | 'complete' | 'failed';
  copiedBytes: number; totalBytes: number; at: number };
export function readSnapshotProgress(home: string): SnapshotProgress | null {
  try { return JSON.parse(readFileSync(snapshotProgressFile(home), 'utf8')) as SnapshotProgress; }
  catch { return null; }
}

/**
 * What a link points at, independent of how the string was written: a junction
 * reads back with or without a trailing separator, a `\\?\` prefix or another
 * case on Windows, and a relative link becomes an absolute junction there.
 * Relative targets resolve against `base`, the link's directory in the tree
 * the link was copied from.
 */
function linkIdentity(base: string, target: string): string {
  const absolute = resolve(base, process.platform === 'win32' ? target.replace(/^\\\\\?\\/, '') : target);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

type TreeInfo = { bytes: number; digest: string; signature: string };

/**
 * Never follow links: npm links are preserved, external content is not part of the backup.
 * `digest` is the stored, byte-exact fingerprint (a restore compares against it); `signature`
 * reads links by identity and tells a copy from its source. `logicalRoot` is where relative
 * links resolve, the source tree when `root` is a copy of it. `entries` collects one
 * fingerprint per path, to name what differs.
 */
function treeInfo(root: string, budget?: { bytes: number; entries: number; deadline: number }, content = true,
  logicalRoot = root, entries?: Map<string, string>): TreeInfo {
  const hash = createHash('sha256');
  const signature = createHash('sha256');
  let bytes = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  function visit(parts: string[]): void {
    const path = join(root, ...parts);
    const stat = lstatSync(path);
    if (budget) {
      budget.entries++;
      budget.bytes += stat.isFile() ? stat.size : 0;
      if (budget.bytes > MAX_PLUGIN_BACKUP_BYTES || budget.entries > MAX_PLUGIN_BACKUP_ENTRIES || Date.now() > budget.deadline)
        throw new Error('plugin backup exceeds the automatic limit (1 GiB, 100,000 entries or 30 seconds)');
    }
    const name = JSON.stringify(parts);
    hash.update(name);
    signature.update(name);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      hash.update('link:' + target);
      const identity = linkIdentity(dirname(join(logicalRoot, ...parts)), target);
      signature.update('link:' + identity);
      entries?.set(parts.join('/'), 'link:' + identity);
      return;
    }
    if (stat.isDirectory()) {
      hash.update('directory');
      signature.update('directory');
      entries?.set(parts.join('/'), 'directory');
      for (const child of readdirSync(path).sort()) visit([...parts, child]);
    } else if (stat.isFile()) {
      bytes += stat.size;
      const header = `file:${stat.size}:`;
      hash.update(header);
      signature.update(header);
      if (!content) return;
      const own = entries ? createHash('sha256') : null;
      const fd = openSync(path, 'r');
      try {
        let count: number;
        while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          const chunk = buffer.subarray(0, count);
          hash.update(chunk);
          signature.update(chunk);
          own?.update(chunk);
          if (budget && Date.now() > budget.deadline) throw new Error('plugin backup exceeded 30 seconds');
        }
      } finally { closeSync(fd); }
      if (own) entries?.set(parts.join('/'), `file:${stat.size}:${own.digest('hex')}`);
    } else throw new Error('plugin backup contains an unsupported special file');
  }
  visit([]);
  return { bytes, digest: hash.digest('hex'), signature: signature.digest('hex') };
}

/** First path whose fingerprint differs between a source tree and its copy, for the error shown to the tester. */
function describeDifference(source: string, copy: string): string {
  try {
    const left = new Map<string, string>();
    const right = new Map<string, string>();
    const deadline = { bytes: 0, entries: 0, deadline: Date.now() + 30_000 };
    treeInfo(source, deadline, true, source, left);
    treeInfo(copy, { ...deadline, bytes: 0, entries: 0 }, true, source, right);
    for (const [path, value] of left) {
      if (right.get(path) !== value) return right.has(path) ? `${path || '.'} differs` : `${path} is missing from the copy`;
    }
    for (const path of right.keys()) if (!left.has(path)) return `${path} appeared during the copy`;
  } catch (error) {
    return `comparison failed: ${(error as Error).message}`;
  }
  return 'no difference found on a second pass';
}

/** Everything a copy holds besides the main database file and the plugins. */
function databaseSideFiles(files: DataFiles): string[] {
  const integrations = integrationsDbPath(files);
  return [`${files.dbPath}-wal`, files.configPath, integrations, `${integrations}-wal`];
}

/** Shared with the approval screen; includes WAL, integrations database, config and both plugin directories. */
export function snapshotRequiredBytes(files: DataFiles): number {
  let bytes = statSync(files.dbPath).size;
  for (const file of databaseSideFiles(files)) if (existsSync(file)) bytes += statSync(file).size;
  const budget = { bytes: 0, entries: 0, deadline: Date.now() + 30_000 };
  for (const slot of PLUGIN_SLOTS) if (lstatSync(join(files.home, slot), { throwIfNoEntry: false })) bytes += treeInfo(join(files.home, slot), budget, false).bytes;
  return Math.ceil(bytes * 1.2 + 64 * 1024 * 1024);
}
export type RestoreRequest = { id: string; snapshot: string; version: string; requestedAt: number };
export type RestoreResult = { id: string; snapshot: string; ok: boolean; error: string | null; at: number };
export type DataFiles = { home: string; dbPath: string; configPath: string };

/** Desktop embedded or desktop service; never a source checkout, never a test. */
export function packagedDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROOKS_DESKTOP_EMBEDDED === '1' || env.ROOKS_DESKTOP_SERVICE === '1';
}

/**
 * A `rooks` of the installed package run from a terminal: the app's runtime
 * (Electron run as Node, or the Node the package ships), without the marker
 * every process the app starts carries. A mission's `rooks` inherits the
 * marker of the daemon that runs it.
 */
export function packagedCli(
  env: NodeJS.ProcessEnv = process.env,
  versions: NodeJS.ProcessVersions = process.versions,
  execPath: string = process.execPath,
): boolean {
  return packagedRuntime({ versions, execPath, platform: process.platform }) && !packagedDaemon(env);
}

/** The release version, shared by the three package.json files. */
export function rooksVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

type Parsed = { core: [number, number, number]; pre: string | null };
function parseVersion(value: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(value.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

/** SemVer precedence of two pre-release tags: dot-separated identifiers, numeric
 *  ones compared as numbers (`rc.10` after `rc.9`), a numeric one before an
 *  alphanumeric one, and a shorter tag first when all its identifiers match. */
function comparePre(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Sign of `a - b`, or `null` when either side is not a release version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  // 0.2.0-beta.1 comes before 0.2.0.
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return comparePre(left.pre, right.pre);
}

export function readDataVersion(home: string): string | null {
  try {
    return readFileSync(dataVersionFile(home), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * A daemon that is not packaged neither waits for approval nor copies the data,
 * and never moves `data-version`. When the data it opens were last used by an
 * older release, say so in its log: a Windows service installed by the CLI of
 * 0.1.3 and earlier ran like this, unnoticed, and migrated without a copy
 * (TIM-0087). `null` when there is nothing to say.
 */
export function unpackagedDataNotice(files: DataFiles, version: string): string | null {
  if (!existsSync(files.dbPath)) return null;
  const recorded = readDataVersion(files.home);
  if (recorded === null || compareVersions(recorded, version) !== -1) return null;
  return `[data] Rooks ${version} is not running as the app's daemon (ROOKS_DESKTOP_SERVICE and ROOKS_DESKTOP_EMBEDDED unset): `
    + `it opens data last used by Rooks ${recorded} without update approval or a backup, and leaves data-version at ${recorded}. `
    + 'If this is the Rooks background service, reinstall it from the Rooks app.';
}

export const updateApprovalFile = (home: string): string => join(home, 'update-approval.json');

/** Missing metadata on an existing database is the legacy 0.1.0 install. */
export function updateNeedsApproval(files: DataFiles, version: string): boolean {
  if (!existsSync(files.dbPath)) return false;
  const recorded = readDataVersion(files.home);
  if (recorded !== null && (compareVersions(version, recorded) ?? 1) <= 0) return false;
  try {
    const approval = JSON.parse(readFileSync(updateApprovalFile(files.home), 'utf8')) as { version?: unknown };
    return approval.version !== version;
  } catch {
    return true;
  }
}

/** Called only by an explicit operator action, never by the startup guard. */
export function approveDataUpdate(home: string, version: string): void {
  writeAtomic(updateApprovalFile(home), `${JSON.stringify({ version, approvedAt: Date.now() })}\n`);
}

export class DataUpdatePendingError extends Error {
  constructor(readonly version: string) {
    super(`Rooks ${version} is waiting for update approval. Run rooks update status, then rooks update approve ${version}.`);
    this.name = 'DataUpdatePendingError';
  }
}

export function assertDataUpdateApproved(files: DataFiles, version: string): void {
  if (updateNeedsApproval(files, version)) throw new DataUpdatePendingError(version);
}

/**
 * A packaged CLI has no update routes to wait on, and the app may not have
 * been opened since this package was installed: the daemon that answers can
 * still be the previous release. It refuses what the app's daemon would wait
 * for, instead of migrating the data without approval or a copy (TODO #535).
 */
export class PackagedCliUpdatePendingError extends Error {
  constructor(readonly version: string, readonly recorded: string | null) {
    super(`These data were last used by ${recorded === null ? 'an earlier Rooks' : `Rooks ${recorded}`} and Rooks ${version} `
      + 'is not yet approved to update them, so this command did not open them. Open the Rooks app to review the update '
      + '(it keeps a copy of your data first), then run this command again. '
      + `Without the app, on Linux or macOS: rooks update apply, then rooks update approve ${version}.`);
    this.name = 'PackagedCliUpdatePendingError';
  }
}

export function assertPackagedCliMayOpen(files: DataFiles, version: string): void {
  if (updateNeedsApproval(files, version)) throw new PackagedCliUpdatePendingError(version, readDataVersion(files.home));
}

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}

export function writeDataVersion(home: string, version: string): void {
  mkdirSync(home, { recursive: true });
  writeAtomic(dataVersionFile(home), `${version}\n`);
}

export function readSnapshotMeta(dir: string): SnapshotMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')) as Partial<SnapshotMeta>;
    if (typeof meta.to !== 'string' || typeof meta.createdAt !== 'number') return null;
    if (meta.pluginCopies !== undefined) {
      if (!meta.pluginCopies || typeof meta.pluginCopies !== 'object') return null;
      for (const slot of PLUGIN_SLOTS) {
        const copy = meta.pluginCopies[slot];
        if (!copy || !['absent', 'saved', 'omitted'].includes(copy.state)) return null;
        if (copy.state === 'saved' && (typeof copy.digest !== 'string' || !/^[a-f0-9]{64}$/.test(copy.digest))) return null;
      }
    }
    if (meta.integrations !== undefined && meta.integrations !== 'saved' && meta.integrations !== 'absent') return null;
    return {
      from: typeof meta.from === 'string' ? meta.from : null,
      to: meta.to,
      createdAt: meta.createdAt,
      ...(typeof meta.config === 'boolean' ? { config: meta.config } : {}),
      ...(meta.pluginCopies ? { pluginCopies: meta.pluginCopies } : {}),
      ...(meta.integrations ? { integrations: meta.integrations } : {}),
      ...(typeof meta.partial === 'string' ? { partial: meta.partial } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Consistent copy of the live database: `VACUUM INTO` reads inside one
 * transaction, so a daemon writing at the same time cannot tear it — unlike a
 * file copy, which misses the `-wal` and silently loses recent writes.
 */
function copyDatabase(dbPath: string, target: string): void {
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    source.prepare('VACUUM INTO ?').run(target);
    // `VACUUM INTO` creates the copy with the umask, not with the source's mode (TODO #864).
    tightenToOwner(target);
  } finally {
    source.close();
  }
}

/** Refuse to fill the disk: a full disk would break the daemon worse than a missing copy. */
function assertRoomFor(bytes: number, dir: string, available?: () => number): void {
  let free: number;
  try {
    const stats = statfsSync(dir);
    free = available ? available() : stats.bavail * stats.bsize;
  } catch {
    return; // Unknown on this filesystem: try, VACUUM INTO fails cleanly when full.
  }
  const needed = bytes * 1.2 + 64 * 1024 * 1024;
  if (free < needed) {
    throw new Error(`not enough free disk space (${Math.round(free / 1e6)} MB free, ${Math.round(needed / 1e6)} MB needed)`);
  }
}

const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Windows refuses to rename a file, or a directory holding one, while another
 * process has it open: Defender scans the database copy just written, the
 * desktop reads the progress file. Such a lock lasts a moment; anything else fails at once.
 */
function renameWhenUnlocked(from: string, to: string, rename: Rename, attempts = 8): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (!LOCKED.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= attempts - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * 2 ** attempt);
    }
  }
}

/** Writes `<backups>/<name>/` in one rename, so a crash never leaves a half copy under that name. */
type SnapshotOpts = { allowPartial?: boolean; availableBytes?: () => number; progress?: (progress: SnapshotProgress) => void; rename?: Rename };
function writeSnapshot(files: DataFiles, name: string, meta: SnapshotMeta, opts: SnapshotOpts = {}): string | undefined {
  const root = backupsDir(files.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let totalBytes = 0;
  let copiedBytes = 0;
  const progress = (phase: SnapshotProgress['phase']) => {
    const value = { version: meta.to, phase, copiedBytes, totalBytes, at: Date.now() };
    // Only the update window reads it: a progress file Windows keeps locked must not fail the copy itself.
    try { writeAtomic(snapshotProgressFile(files.home), `${JSON.stringify(value)}\n`); } catch { /* shown late or not at all */ }
    opts.progress?.(value);
  };
  progress('scanning');
  const copies: Record<PluginSlot, PluginCopy> = { plugins: { state: 'omitted' }, 'plugins-data': { state: 'omitted' } };
  const signatures: Partial<Record<PluginSlot, string>> = {};
  const budget = { bytes: 0, entries: 0, deadline: Date.now() + 30_000 };
  let partial: string | undefined;
  let baseBytes = statSync(files.dbPath).size;
  for (const file of databaseSideFiles(files)) if (existsSync(file)) baseBytes += statSync(file).size;
  try {
    for (const slot of PLUGIN_SLOTS) {
      const source = join(files.home, slot);
      const entry = lstatSync(source, { throwIfNoEntry: false });
      if (!entry) { copies[slot] = { state: 'absent' }; continue; }
      if (!entry.isDirectory()) throw new Error(`${slot} is not a directory`);
      const info = treeInfo(source, budget);
      totalBytes += info.bytes;
      copies[slot] = { state: 'saved', digest: info.digest };
      signatures[slot] = info.signature;
    }
    assertRoomFor(baseBytes + totalBytes, root, opts.availableBytes);
  } catch (error) {
    if (!opts.allowPartial) { progress('failed'); throw error; }
    partial = (error as Error).message;
    for (const slot of PLUGIN_SLOTS) {
      if (copies[slot].state !== 'absent') copies[slot] = { state: 'omitted' };
    }
    totalBytes = 0;
  }
  assertRoomFor(baseBytes, root, opts.availableBytes);
  const temp = join(root, `.${name}.tmp-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { mode: 0o700 });
  try {
    progress('database');
    // Integrations first, like `rooks export`: a mission created between the two copies is then
    // in the saved `rooks.db`, where its receipt id finds it again instead of spawning a second one.
    const integrations = existsSync(integrationsDbPath(files)) ? 'saved' : 'absent';
    if (integrations === 'saved') copyDatabase(integrationsDbPath(files), join(temp, INTEGRATIONS_DB));
    copyDatabase(files.dbPath, join(temp, 'rooks.db'));
    const config = existsSync(files.configPath);
    if (config) copyFileSync(files.configPath, join(temp, 'rooks.config.json'));
    if (!partial) {
      try {
        progress('plugins');
        // The plugin limit measures the plugins: the database copy before it can take longer than
        // that on its own, and made every update of a long-used Windows install partial (TIM-0077).
        budget.deadline = Date.now() + 30_000;
        let copyingBytes = 0;
        let copyingEntries = 0;
        for (const slot of PLUGIN_SLOTS) {
          const copy = copies[slot];
          if (copy.state !== 'saved') continue;
          const source = join(files.home, slot);
          // Something else may write to the plugins while they are copied: rescan and copy again before giving up.
          let checked: TreeInfo | undefined;
          for (let attempt = 1; !checked; attempt++) {
            rmSync(join(temp, slot), { recursive: true, force: true });
            copyTree(source, join(temp, slot), (entry) => {
              const stat = lstatSync(entry);
              copyingBytes += stat.isFile() ? stat.size : 0;
              copyingEntries++;
              if (copyingBytes > MAX_PLUGIN_BACKUP_BYTES || copyingEntries > MAX_PLUGIN_BACKUP_ENTRIES)
                throw new Error('plugin content grew beyond the automatic backup limit');
              if (Date.now() > budget.deadline) throw new Error('plugin backup exceeded 30 seconds');
            });
            const candidate = treeInfo(join(temp, slot), { bytes: 0, entries: 0, deadline: budget.deadline }, true, source);
            if (candidate.signature === signatures[slot]) { checked = candidate; break; }
            if (attempt >= 3) throw new Error(`${slot} changed during its copy (${describeDifference(source, join(temp, slot))})`);
            copyingBytes = 0;
            copyingEntries = 0;
            budget.deadline = Date.now() + 30_000;
            signatures[slot] = treeInfo(source, { bytes: 0, entries: 0, deadline: budget.deadline }).signature;
          }
          // A restore verifies the saved copy against this digest: it is the copy's own, links as they were recreated.
          copies[slot] = { state: 'saved', digest: checked.digest };
          copiedBytes += checked.bytes;
          progress('plugins');
        }
      } catch (error) {
        if (!opts.allowPartial) throw error;
        partial = (error as Error).message;
        for (const slot of PLUGIN_SLOTS) {
          rmSync(join(temp, slot), { recursive: true, force: true });
          if (copies[slot].state !== 'absent') copies[slot] = { state: 'omitted' };
        }
      }
    }
    writeFileSync(join(temp, 'snapshot.json'), `${JSON.stringify({ ...meta, config, pluginCopies: copies, integrations, ...(partial ? { partial } : {}) })}\n`, { mode: 0o600 });
    const target = join(root, name);
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    renameWhenUnlocked(temp, target, opts.rename ?? renameSync);
    try { progress('complete'); } catch { /* The published copy is already complete. */ }
    return partial;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    progress('failed');
    throw error;
  }
}

/** Keeps the `KEPT_SNAPSHOTS` most recent `pre-*` copies and drops leftovers of interrupted ones. */
export function pruneSnapshots(home: string, keep = KEPT_SNAPSHOTS): void {
  const root = backupsDir(home);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    // An hour-old temporary copy was interrupted; a recent one may still be written by another process.
    if (/^\.(pre-.*|before-restore)\.tmp-\d+$/.test(name) && Date.now() - statSync(join(root, name)).mtimeMs > 3_600_000) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
  const snapshots = names
    .filter((name) => SNAPSHOT_NAME.test(name))
    .map((name) => ({ name, createdAt: readSnapshotMeta(join(root, name))?.createdAt ?? 0 }))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const { name } of snapshots.slice(keep)) rmSync(join(root, name), { recursive: true, force: true });
}

export type GuardOutcome = 'current' | 'fresh' | 'snapshot' | 'older' | 'unprotected';

/**
 * A migration that rewrites or drops what 0.1.0 reads — a table rebuild like
 * ui_layout's, a dropped or renamed table or column, a NOT NULL column
 * without default on a table 0.1.0 inserts into. `applied` answers on the
 * database as it is before `db.ts` migrates it (opened read-only); `breaks`
 * names what 0.1.0 loses (`table` or `table.column`), which is how
 * `db-downgrade-compat.test.ts` tells a declared migration from a forgotten one.
 */
export type DestructiveMigration = {
  id: string;
  breaks: readonly string[];
  applied: (db: Database.Database) => boolean;
};

/**
 * Every destructive migration of `db.ts`, declared in the same commit as the
 * migration itself. Without an entry, a failed copy would let it run on data
 * nothing can bring back — and the downgrade test fails.
 */
export const DESTRUCTIVE_MIGRATIONS: readonly DestructiveMigration[] = [
  // TODO #906: the account tables leave the core's schema, their rows written to
  // `legacy-account-tables.json` first (`users/legacy-account-tables.ts`).
  {
    id: 'account-tables-to-file',
    breaks: [...LEGACY_ACCOUNT_TABLES, 'users.role_id'],
    applied: (db) => !legacyAccountTablesPresent(db),
  },
];

/**
 * Ids of the declared destructive migrations this database has not had yet.
 * A database that cannot be read is assumed to need them all: refusing to
 * start is the safe answer when the copy failed too.
 */
export function pendingDestructiveMigrations(
  dbPath: string,
  registry: readonly DestructiveMigration[] = DESTRUCTIVE_MIGRATIONS,
): string[] {
  if (!registry.length) return [];
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return registry.map((m) => m.id);
  }
  try {
    return registry.filter((m) => {
      try {
        return !m.applied(db);
      } catch {
        return true;
      }
    }).map((m) => m.id);
  } finally {
    db.close();
  }
}

/** Why a version refused to start, worded for the person who installed it. */
export class DataSnapshotError extends Error {
  constructor(readonly version: string, readonly reason: string, home: string, readonly migrations: readonly string[] = []) {
    super(
      `Rooks ${version} did not start: it must convert your data in a way older versions cannot read, `
      + `and it could not save a copy of them first (${reason}). `
      + `Nothing was changed in ${home}. Free some disk space on that drive and start Rooks again, `
      + 'or reinstall the version you used before.',
    );
    this.name = 'DataSnapshotError';
  }
}

/**
 * `blocking`: the version refused to start; otherwise it runs without a copy, retried at each
 * start. `partial`: database and configuration were saved, the plugins were not; never retried
 * for this version, so the desktop says it once.
 */
export type SnapshotFailure = { version: string; message: string; at: number; blocking: boolean; partial?: true };
// A full disk can prevent persisting the warning; the running daemon still exposes it.
const snapshotFailures = new Map<string, SnapshotFailure>();

function unprotectedMessage(version: string, reason: string): string {
  return `Rooks ${version} started without saving a copy of your data (${reason}). `
    + 'Its changes to your data only add to them: the version you used before can still open them. '
    + 'Free some disk space on that drive; Rooks tries again at its next start.';
}

/** Left for the desktop, which shows it instead of a bare "the daemon keeps crashing". */
export function readSnapshotFailure(home: string): SnapshotFailure | null {
  const current = snapshotFailures.get(home);
  if (current) return current;
  try {
    const parsed = JSON.parse(readFileSync(snapshotFailureFile(home), 'utf8')) as Partial<SnapshotFailure>;
    if (typeof parsed.version !== 'string' || typeof parsed.message !== 'string' || typeof parsed.at !== 'number') return null;
    return { version: parsed.version, message: parsed.message, at: parsed.at, blocking: parsed.blocking !== false,
      ...(parsed.partial === true ? { partial: true as const } : {}) };
  } catch {
    return null;
  }
}

/**
 * Runs after the approval guard, before any packaged process opens the
 * database. db.ts retains both guards so an indirect import cannot bypass
 * the waiting daemon's control plane.
 *
 * When the copy cannot be made, throws `DataSnapshotError` if a declared
 * destructive migration is pending on this database — the caller must not open the database then — and
 * otherwise warns and returns `unprotected`. Either way `data-version` is not
 * advanced, so the next start tries the copy again.
 */
export function protectDataBeforeOpen(
  files: DataFiles,
  version: string,
  opts: { now?: () => number; warn?: (message: string) => void; destructive?: readonly DestructiveMigration[]; availableBytes?: () => number; progress?: (progress: SnapshotProgress) => void; rename?: Rename } = {},
): GuardOutcome {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const now = opts.now ?? Date.now;
  const recorded = readDataVersion(files.home);
  if (recorded === version) return 'current';
  if (recorded !== null && (compareVersions(version, recorded) ?? 1) < 0) {
    // The desktop offers the restore; the file stays newer until the user chose.
    warn(`[data] these data were last written by Rooks ${recorded}; this is ${version}`);
    return 'older';
  }
  if (!existsSync(files.dbPath)) {
    writeDataVersion(files.home, version);
    return 'fresh';
  }
  let partial: string | undefined;
  try {
    partial = writeSnapshot(files, snapshotName(version), { from: recorded, to: version, createdAt: now() }, {
      allowPartial: pendingDestructiveMigrations(files.dbPath, opts.destructive).length === 0,
      availableBytes: opts.availableBytes, progress: opts.progress, rename: opts.rename,
    });
  } catch (error) {
    try {
      const progress = readSnapshotProgress(files.home);
      if (progress) writeAtomic(snapshotProgressFile(files.home), `${JSON.stringify({ ...progress, phase: 'failed', at: now() })}\n`);
    } catch { /* A full disk may also prevent the progress update. */ }
    const reason = (error as Error).message;
    const pending = pendingDestructiveMigrations(files.dbPath, opts.destructive);
    const blocking = pending.length > 0;
    const refusal = new DataSnapshotError(version, reason, files.home, pending);
    const message = blocking ? refusal.message : unprotectedMessage(version, reason);
    const failure = { version, message, at: now(), blocking };
    snapshotFailures.set(files.home, failure);
    try {
      mkdirSync(backupsDir(files.home), { recursive: true, mode: 0o700 });
      writeAtomic(snapshotFailureFile(files.home), `${JSON.stringify(failure)}\n`);
    } catch {
      // A full disk may refuse this too; the message still reaches the log.
    }
    if (blocking) throw refusal;
    warn(`[data] ${message}`);
    return 'unprotected';
  }
  try {
    pruneSnapshots(files.home);
  } catch (error) {
    warn(`[data] could not remove an old copy of the data: ${(error as Error).message}`);
  }
  rmSync(snapshotFailureFile(files.home), { force: true });
  snapshotFailures.delete(files.home);
  if (partial) {
    const message = `Rooks ${version} saved a partial backup: database and configuration only (${partial}). Plugins and plugin data were not copied and will be left unchanged by a restore. Keep a separate copy of both folders for manual restoration.`;
    const failure: SnapshotFailure = { version, message, at: now(), blocking: false, partial: true };
    snapshotFailures.set(files.home, failure);
    writeAtomic(snapshotFailureFile(files.home), `${JSON.stringify(failure)}\n`);
    warn(`[data] ${message}`);
  }
  writeDataVersion(files.home, version);
  return 'snapshot';
}

function isRequest(value: unknown): value is RestoreRequest {
  const r = value as Partial<RestoreRequest> | null;
  return !!r && typeof r.id === 'string' && typeof r.snapshot === 'string' && typeof r.version === 'string'
    && typeof r.requestedAt === 'number';
}

export function readRestoreRequest(home: string): RestoreRequest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(restoreRequestFile(home), 'utf8'));
    return isRequest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A step of the restore, named for the tests that make it fail. */
export type RestoreStep = 'staged' | `aside:${RestoreSlot}` | `swap:${RestoreSlot}`;
type IntegrationSlot = 'integrations' | 'integrations-wal' | 'integrations-shm';
type RestoreSlot = 'db' | 'wal' | 'shm' | 'config' | 'data-version' | PluginSlot | IntegrationSlot;
const INTEGRATION_SLOTS: readonly RestoreSlot[] = ['integrations', 'integrations-wal', 'integrations-shm'];
const SLOTS: readonly RestoreSlot[] = ['db', 'wal', 'shm', 'config', 'data-version', ...PLUGIN_SLOTS, ...INTEGRATION_SLOTS];
/** What a journal written before `slots` existed covered. */
const LEGACY_SLOTS: readonly RestoreSlot[] = SLOTS.filter((s) => !PLUGIN_SLOTS.includes(s as PluginSlot) && !INTEGRATION_SLOTS.includes(s));
/** `rename` is replaceable so tests can give it Windows' semantics on any OS. */
type Rename = (from: string, to: string) => void;
type RestoreOpts = { now?: () => number; fault?: (step: RestoreStep) => void; rename?: Rename };
/** Written before the first file moves; its removal is the commit point. */
type RestoreJournal = { id: string; snapshot: string; present: RestoreSlot[]; slots?: RestoreSlot[] };

function slotPath(files: DataFiles, slot: RestoreSlot): string {
  switch (slot) {
    case 'db': return files.dbPath;
    case 'wal': return `${files.dbPath}-wal`;
    case 'shm': return `${files.dbPath}-shm`;
    case 'config': return files.configPath;
    case 'data-version': return dataVersionFile(files.home);
    case 'plugins': case 'plugins-data': return join(files.home, slot);
    case 'integrations': return integrationsDbPath(files);
    case 'integrations-wal': return `${integrationsDbPath(files)}-wal`;
    case 'integrations-shm': return `${integrationsDbPath(files)}-shm`;
  }
}
const asidePath = (files: DataFiles, slot: RestoreSlot): string => `${slotPath(files, slot)}.restore-old`;
const stagedPath = (files: DataFiles, slot: RestoreSlot): string => `${slotPath(files, slot)}.restoring`;

function readJournal(home: string): RestoreJournal | null {
  try {
    const parsed = JSON.parse(readFileSync(restoreJournalFile(home), 'utf8')) as Partial<RestoreJournal>;
    if (typeof parsed.id !== 'string' || typeof parsed.snapshot !== 'string' || !Array.isArray(parsed.present)) return null;
    if (parsed.slots !== undefined && (!Array.isArray(parsed.slots) || parsed.slots.some((slot) => !SLOTS.includes(slot)))) return null;
    return { id: parsed.id, snapshot: parsed.snapshot, present: parsed.present.filter((s): s is RestoreSlot => SLOTS.includes(s)),
      slots: parsed.slots ?? [...LEGACY_SLOTS] };
  } catch {
    return null;
  }
}

/**
 * Puts every file back where it was before the restore started. A slot that
 * had a file gets it back from its aside copy (if it was moved at all); a
 * slot that had none is emptied of whatever the restore put there.
 */
function rollBack(files: DataFiles, present: readonly RestoreSlot[], rename: Rename, slots: readonly RestoreSlot[] = SLOTS): void {
  for (const slot of [...slots].reverse()) {
    const target = slotPath(files, slot);
    const aside = asidePath(files, slot);
    if (present.includes(slot)) {
      if (!existsSync(aside)) continue;
      // Windows refuses to rename onto an existing file (EEXIST/EPERM): clear
      // the target first. The original stays in `aside` until the rename
      // succeeds; if it fails, the journal keeps it for the next start.
      rmSync(target, { recursive: true, force: true });
      rename(aside, target);
    } else {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

function dropLeftovers(files: DataFiles): void {
  for (const slot of SLOTS) {
    rmSync(stagedPath(files, slot), { recursive: true, force: true });
    rmSync(asidePath(files, slot), { recursive: true, force: true });
  }
}

/**
 * A process killed in the middle of a restore leaves its journal: the files
 * go back to their state before it, and the attempt is reported as failed.
 * Throws when that cannot be done — the database must not be opened then.
 */
function recoverInterruptedRestore(files: DataFiles, now: () => number, rename: Rename): void {
  if (!existsSync(restoreJournalFile(files.home))) return;
  const journal = readJournal(files.home);
  if (!journal) throw new Error(`unreadable restore journal: ${restoreJournalFile(files.home)}`);
  rollBack(files, journal.present, rename, journal.slots);
  rmSync(restoreJournalFile(files.home), { force: true });
  dropLeftovers(files);
  const result: RestoreResult = {
    id: journal.id, snapshot: journal.snapshot, ok: false,
    error: 'the restore was interrupted; the data were left as they were', at: now(),
  };
  writeAtomic(lastRestoreFile(files.home), `${JSON.stringify(result)}\n`);
}

/**
 * Applies the restore the user asked for, if it names this version. Another
 * version leaves it alone: during a downgrade the newer daemon is still
 * running until the older one replaces it, and it must not restore — its own
 * migrations would run on the copy right after.
 *
 * Throws only when the data are left in a state the database must not be
 * opened in (an interrupted restore that could not be undone).
 */
export function applyPendingRestore(files: DataFiles, version: string, opts: RestoreOpts = {}): RestoreResult | null {
  const now = opts.now ?? Date.now;
  const rename = opts.rename ?? renameSync;
  recoverInterruptedRestore(files, now, rename);
  const request = readRestoreRequest(files.home);
  if (!request) {
    // Unreadable request: drop it rather than keep checking it at every start.
    if (existsSync(restoreRequestFile(files.home))) rmSync(restoreRequestFile(files.home), { force: true });
    return null;
  }
  if (request.version !== version) return null;
  // One attempt per click, even if this process dies during it.
  rmSync(restoreRequestFile(files.home), { force: true });
  let result: RestoreResult;
  try {
    restoreSnapshot(files, request, now, opts.fault ?? (() => {}), rename);
    result = { id: request.id, snapshot: request.snapshot, ok: true, error: null, at: now() };
  } catch (error) {
    if (existsSync(restoreJournalFile(files.home))) throw error;
    result = { id: request.id, snapshot: request.snapshot, ok: false, error: (error as Error).message, at: now() };
  }
  writeAtomic(lastRestoreFile(files.home), `${JSON.stringify(result)}\n`);
  return result;
}

function verifyDatabase(path: string): void {
  const check = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const verdict = check.pragma('quick_check', { simple: true });
    if (verdict !== 'ok') throw new Error(`the saved database is damaged (${String(verdict)})`);
  } finally {
    check.close();
  }
}

function restoreSnapshot(
  files: DataFiles,
  request: RestoreRequest,
  now: () => number,
  fault: (step: RestoreStep) => void,
  rename: Rename,
): void {
  const { snapshot } = request;
  if (!SNAPSHOT_NAME.test(snapshot)) throw new Error(`invalid snapshot name: ${snapshot}`);
  const dir = join(backupsDir(files.home), snapshot);
  const savedDb = join(dir, 'rooks.db');
  const savedConfig = join(dir, 'rooks.config.json');
  const meta = readSnapshotMeta(dir);
  if (!meta || !existsSync(savedDb)) throw new Error(`the copy ${snapshot} is missing or incomplete`);
  // Copies written before the flag existed: the file itself says.
  const hasConfig = meta.config ?? existsSync(savedConfig);
  if (hasConfig && !existsSync(savedConfig)) throw new Error(`the copy ${snapshot} lost its configuration file`);

  const savedIntegrations = join(dir, INTEGRATIONS_DB);
  if (meta.integrations === 'saved' && !existsSync(savedIntegrations)) throw new Error(`the copy ${snapshot} lost its integrations database`);
  // Legacy and explicitly partial copies never imply that plugins were absent; a copy older than
  // the integrations database leaves the live one as it is.
  const slots = SLOTS.filter((slot) => {
    if (PLUGIN_SLOTS.includes(slot as PluginSlot)) return ['saved', 'absent'].includes(meta.pluginCopies?.[slot as PluginSlot]?.state ?? '');
    if (INTEGRATION_SLOTS.includes(slot)) return meta.integrations !== undefined;
    return true;
  });
  dropLeftovers(files);
  try {
    for (const slot of PLUGIN_SLOTS) {
      const copy = meta.pluginCopies?.[slot];
      if (copy?.state !== 'saved') continue;
      const source = join(dir, slot);
      if (!lstatSync(source).isDirectory()) throw new Error(`${slot} backup is not a directory`);
      copyTree(source, stagedPath(files, slot));
      if (treeInfo(stagedPath(files, slot)).digest !== copy.digest) throw new Error(`${slot} backup is damaged`);
    }
    // Everything that will replace the live files is written and checked
    // first, next to them so that the swap below is made of renames only.
    copyFileSync(savedDb, stagedPath(files, 'db'));
    verifyDatabase(stagedPath(files, 'db'));
    if (meta.integrations === 'saved') {
      copyFileSync(savedIntegrations, stagedPath(files, 'integrations'));
      verifyDatabase(stagedPath(files, 'integrations'));
    }
    if (hasConfig) copyFileSync(savedConfig, stagedPath(files, 'config'));
    // The copy holds what `meta.from` wrote. Unknown (the version before
    // snapshots existed): no file, so this version snapshots again.
    if (meta.from) writeFileSync(stagedPath(files, 'data-version'), `${meta.from}\n`, { mode: 0o600 });
    // What the user is about to lose stays on disk until the next restore.
    if (existsSync(files.dbPath)) {
      const restoresPlugins = PLUGIN_SLOTS.some((slot) => slots.includes(slot));
      try {
        writeSnapshot(files, BEFORE_RESTORE, { from: readDataVersion(files.home), to: meta.to, createdAt: now() }, {
          allowPartial: !restoresPlugins,
        });
      } catch (error) {
        if (restoresPlugins)
          throw new Error(`Cannot back up your current plugins before restoration (${(error as Error).message}): restoration cancelled.`);
        throw error;
      }
    }
    fault('staged');
  } catch (error) {
    dropLeftovers(files);
    throw error;
  }

  const present = slots.filter((slot) => existsSync(slotPath(files, slot)));
  const journal: RestoreJournal = { id: request.id, snapshot, present, slots };
  writeAtomic(restoreJournalFile(files.home), `${JSON.stringify(journal)}\n`);
  try {
    // An old -wal left next to the restored file would be replayed onto it:
    // it moves aside with the rest.
    for (const slot of present) {
      rename(slotPath(files, slot), asidePath(files, slot));
      fault(`aside:${slot}`);
    }
    for (const slot of slots) {
      if (!existsSync(stagedPath(files, slot))) continue;
      rename(stagedPath(files, slot), slotPath(files, slot));
      fault(`swap:${slot}`);
    }
  } catch (error) {
    try {
      rollBack(files, present, rename, slots);
    } catch (rollbackError) {
      // The journal stays: the next start retries the rollback before opening anything.
      throw new Error(`restore failed (${(error as Error).message}) and could not be undone: ${(rollbackError as Error).message}`);
    }
    rmSync(restoreJournalFile(files.home), { force: true });
    dropLeftovers(files);
    throw error;
  }
  rmSync(restoreJournalFile(files.home), { force: true });
  dropLeftovers(files);
}

/**
 * A restore requested while this version already runs — its supervisor
 * started it before the desktop asked — needs a fresh start. Every
 * supervisor restarts a daemon that exits with a failure code.
 */
export function watchRestoreRequest(home: string, version: string, onRequest: () => void, everyMs = 2_000): () => void {
  const timer = setInterval(() => {
    if (readRestoreRequest(home)?.version !== version) return;
    clearInterval(timer);
    onRequest();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
