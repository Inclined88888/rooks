/**
 * The desktop half of going back to an older version: offer, before the
 * window opens, to put back the data copied just before the newer version
 * first touched them.
 *
 * The daemon writes the copies and `data-version`, and applies the restore
 * (`orchestrator/src/data-version.ts` — same file formats, the two packages
 * being independent). This side only reads them and, after a click, writes one
 * of two things: the restore request, or `data-version` when the user keeps
 * the current data. Nothing is restored without that click. It also keeps its
 * own `backups/snapshot-warning-shown.json`, which the daemon never reads.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellText } from './shell-i18n.js';

export type RestoreOffer = { dataVersion: string; snapshot: string; createdAt: number };
export type RestoreRequest = { id: string; snapshot: string; version: string; requestedAt: number };
export type RestoreOutcome = { ok: boolean; error: string | null };

const dataVersionFile = (home: string): string => join(home, 'data-version');
const backupsDir = (home: string): string => join(home, 'backups');
const requestFile = (home: string): string => join(backupsDir(home), 'restore-request.json');
const lastRestoreFile = (home: string): string => join(backupsDir(home), 'last-restore.json');
const snapshotFailureFile = (home: string): string => join(backupsDir(home), 'snapshot-failure.json');
const snapshotWarningShownFile = (home: string): string => join(backupsDir(home), 'snapshot-warning-shown.json');
export const snapshotName = (version: string): string =>
  `pre-${version.trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'unknown'}`;

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
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return comparePre(left.pre, right.pre);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}

function pendingRequest(home: string): RestoreRequest | null {
  const r = readJson(requestFile(home)) as Partial<RestoreRequest> | null;
  return r && typeof r.id === 'string' && typeof r.version === 'string' && typeof r.snapshot === 'string'
    && typeof r.requestedAt === 'number' ? r as RestoreRequest : null;
}

/** Data last written by a newer version that left a copy from before it: the only case with a choice. */
export function restoreOffer(home: string, appVersion: string): RestoreOffer | null {
  let dataVersion: string;
  try {
    dataVersion = readFileSync(dataVersionFile(home), 'utf8').trim();
  } catch {
    return null;
  }
  if ((compareVersions(dataVersion, appVersion) ?? 0) <= 0) return null;
  // Already chosen: the daemon of this version applies it at its next start.
  if (pendingRequest(home)?.version === appVersion) return null;
  const snapshot = snapshotName(dataVersion);
  const dir = join(backupsDir(home), snapshot);
  const meta = readJson(join(dir, 'snapshot.json')) as { createdAt?: unknown } | null;
  if (!existsSync(join(dir, 'rooks.db')) || typeof meta?.createdAt !== 'number') return null;
  return { dataVersion, snapshot, createdAt: meta.createdAt };
}

export function requestRestore(home: string, offer: RestoreOffer, appVersion: string, now = Date.now()): RestoreRequest {
  const request: RestoreRequest = { id: randomUUID(), snapshot: offer.snapshot, version: appVersion, requestedAt: now };
  mkdirSync(backupsDir(home), { recursive: true });
  writeAtomic(requestFile(home), `${JSON.stringify(request)}\n`);
  return request;
}

/** "Continue": this version now owns the data, so the question is not asked again. */
export function keepCurrentData(home: string, appVersion: string): void {
  writeAtomic(dataVersionFile(home), `${appVersion}\n`);
}

export function restorePending(home: string, id: string): boolean {
  return pendingRequest(home)?.id === id;
}

/** What the daemon reported for this request; `null` while it has not run. */
export function restoreOutcome(home: string, id: string): RestoreOutcome | null {
  const r = readJson(lastRestoreFile(home)) as { id?: unknown; ok?: unknown; error?: unknown } | null;
  if (r?.id !== id || typeof r.ok !== 'boolean') return null;
  return { ok: r.ok, error: typeof r.error === 'string' ? r.error : null };
}

/** `partial`: database and configuration were saved, not the plugins. `at` tells one attempt from the next. */
export type SnapshotFailure = { message: string; blocking: boolean; partial?: true; at?: number };

/**
 * The daemon of this version could not save the copy of the data it was
 * about to migrate. `blocking`: it refused to start (a destructive migration
 * was pending); otherwise it runs without a copy, or with a partial one. Its message already says
 * what to do; the desktop shows it rather than a bare crash report.
 */
export function snapshotFailure(home: string, appVersion: string): SnapshotFailure | null {
  const r = readJson(snapshotFailureFile(home)) as { version?: unknown; message?: unknown; blocking?: unknown; partial?: unknown; at?: unknown } | null;
  if (r?.version !== appVersion || typeof r.message !== 'string') return null;
  return { message: r.message, blocking: r.blocking !== false,
    ...(r.partial === true ? { partial: true as const } : {}), ...(typeof r.at === 'number' ? { at: r.at } : {}) };
}

/**
 * A warning that does not stop Rooks, unless it was already shown. Each start
 * without a copy retries and records a new attempt, which is shown again; a
 * partial copy is never retried for this version, so it is shown once instead
 * of at every launch (TIM-0068).
 */
export function unshownSnapshotWarning(home: string, appVersion: string): SnapshotFailure | null {
  const failure = snapshotFailure(home, appVersion);
  if (!failure || failure.blocking) return null;
  const shown = readJson(snapshotWarningShownFile(home)) as { at?: unknown } | null;
  return failure.at !== undefined && shown?.at === failure.at ? null : failure;
}

export function markSnapshotWarningShown(home: string, failure: SnapshotFailure): void {
  if (failure.at === undefined) return;
  try {
    mkdirSync(backupsDir(home), { recursive: true });
    writeFileSync(snapshotWarningShownFile(home), `${JSON.stringify({ at: failure.at })}\n`);
  } catch { /* Shown again at the next launch, at worst. */ }
}

export function snapshotFailureDialog(failure: SnapshotFailure, locale: string): { message: string; detail: string } {
  const t = shellText(locale);
  return { message: t(failure.partial ? 'backup.partial' : 'backup.failed'), detail: failure.message };
}

/** Button 0 keeps the data: the default and the answer to Escape never erase anything. */
export function restoreDialog(offer: RestoreOffer, appVersion: string, home: string, locale: string): {
  message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number;
} {
  const t = shellText(locale);
  const when = new Date(offer.createdAt).toLocaleString(t.tag, { dateStyle: 'long', timeStyle: 'short' });
  const kept = join(home, 'backups', 'before-restore');
  const { dataVersion: newer } = offer;
  return {
    message: t('restore.message', { newer }),
    detail: t('restore.detail', { appVersion, when, newer, kept }),
    buttons: [t('restore.continue'), t('restore.restore', { when })],
    defaultId: 0, cancelId: 0,
  };
}
