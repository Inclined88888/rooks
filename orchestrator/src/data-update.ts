/** Pre-database control plane: importing this module must never import db.ts. */
import express, { type Express } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  approveDataUpdate, backupsDir, compareVersions, DataSnapshotError,
  pendingDestructiveMigrations, protectDataBeforeOpen, readDataVersion,
  readSnapshotFailure, readSnapshotProgress, snapshotRequiredBytes, snapshotName, updateNeedsApproval,
  type DataFiles, type DestructiveMigration, type SnapshotFailure,
} from './data-version.js';
import { DataOpenLockTimeoutError, holdDataOpenLock, releaseDataOpenLock } from './data-open-lock.js';

export const updateTokenFile = (home: string): string => join(home, 'update-token');

/** OS ownership authorizes this narrow operation without needing a user database. */
export function ensureUpdateToken(home: string): string {
  const file = updateTokenFile(home);
  try {
    writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid update token file');
  return token;
}

export function createDataUpdate(files: DataFiles, version: string, opts: {
  migrate: () => Promise<void>;
  destructive?: readonly DestructiveMigration[];
  snapshotError?: DataSnapshotError;
}) {
  let phase: 'pending' | 'applying' | 'ready' | 'failed' = updateNeedsApproval(files, version) ? 'pending' : 'ready';
  const previousFailure = readSnapshotFailure(files.home);
  if (previousFailure?.version === version && previousFailure.blocking) phase = 'failed';
  if (opts.snapshotError) phase = 'failed';
  let error: string | null = opts.snapshotError?.message ?? null;
  let snapshotFailure: SnapshotFailure | null = previousFailure;
  let migrationFailed = false;
  let estimate: { at: number; bytes: number | null } | undefined;
  const status = () => {
    let requiredBytes: number | null = null;
    let availableBytes: number | null = null;
    try {
      // Status polling must not repeatedly walk a large plugin installation.
      if (!estimate || Date.now() - estimate.at > 5000) {
        estimate = { at: Date.now(), bytes: null };
        estimate.bytes = existsSync(files.dbPath) ? snapshotRequiredBytes(files) : 0;
      }
      requiredBytes = estimate.bytes;
    } catch { /* Unknown or over the automatic limits: the copy reports the precise reason. */ }
    try {
      const stat = statfsSync(existsSync(backupsDir(files.home)) ? backupsDir(files.home) : files.home);
      availableBytes = stat.bavail * stat.bsize;
    } catch { /* Filesystems without statfs still get the snapshot attempt. */ }
    return {
      status: phase, dataVersion: readDataVersion(files.home), daemonVersion: version,
      approvalRequired: updateNeedsApproval(files, version),
      destructiveMigrations: pendingDestructiveMigrations(files.dbPath, opts.destructive),
      backup: { path: join(backupsDir(files.home), snapshotName(version)), requiredBytes, availableBytes,
        // The recorded failure first: loading db.ts retries the copy after approval, and the
        // desktop keys its warning on the attempt it shows (`at`).
        progress: readSnapshotProgress(files.home), failure: readSnapshotFailure(files.home) ?? snapshotFailure }, error,
    };
  };
  const approve = async () => {
    if (phase === 'applying') return 409;
    // Failed module evaluation is cached by Node. A migration failure needs a fresh process.
    if (migrationFailed) return 409;
    const recorded = readDataVersion(files.home);
    if (recorded !== null && (compareVersions(version, recorded) ?? 0) < 0) return 409;
    if (phase === 'ready') return 200;
    phase = 'applying';
    error = null;
    try {
      approveDataUpdate(files.home, version);
      // Outside the dynamic import: a failed destructive snapshot remains retryable.
      snapshotFailure = null;
      // db.ts releases it after its last migration; a failure below releases it in `finally`.
      holdDataOpenLock(files.home);
      protectDataBeforeOpen(files, version, { destructive: opts.destructive, warn: (message) => {
        // The recorded failure, `partial` and `at` included: the desktop keys its warning on them.
        snapshotFailure = readSnapshotFailure(files.home) ?? { version, message, blocking: false, at: Date.now() };
        console.warn(message);
      } });
      try { await opts.migrate(); } catch (cause) { migrationFailed = true; throw cause; }
      phase = 'ready';
      return 200;
    } catch (cause) {
      phase = 'failed';
      if (cause instanceof DataSnapshotError) snapshotFailure = { version, message: cause.message, blocking: true, at: Date.now() };
      // A packaged CLI still converting the data: nothing was changed here, a later approval retries.
      error = cause instanceof DataSnapshotError || cause instanceof DataOpenLockTimeoutError
        ? cause.message : 'Update failed. Restart Timon before trying again.';
      return 500;
    } finally {
      releaseDataOpenLock(files.home);
    }
  };
  return { status, approve };
}

export type DataUpdate = ReturnType<typeof createDataUpdate>;

/** Explicit auth, even on loopback: only the local CLI / Electron main process. */
export function mountDataUpdateRoutes(app: Express, update: DataUpdate, token: string): void {
  const router = express.Router();
  router.use((req, res, next) => {
    const supplied = Buffer.from(req.get('authorization')?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(token);
    // No browser credentials, cookies, daemon-token fallback, CORS or query secrets.
    if (req.get('origin') || req.get('sec-fetch-site') || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)) {
      res.status(401).json({ error: 'update_auth_required' }); return;
    }
    next();
  });
  router.get('/status', (_req, res) => { res.json(update.status()); });
  router.post('/approve', express.json({ limit: '1kb' }), async (req, res) => {
    const parsed = z.object({ version: z.string(), approve: z.literal(true) }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid_update_approval' }); return; }
    if (parsed.data.version !== update.status().daemonVersion) {
      res.status(409).json({ error: 'update_version_mismatch' }); return;
    }
    const code = await update.approve();
    res.status(code).json(update.status());
  });
  app.use('/api/update', router);
}
