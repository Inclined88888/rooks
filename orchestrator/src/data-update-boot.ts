/** This entire import graph is database-free until the operator approves. */
import express from 'express';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { loadConfig } from './config/load.js';
import { closeAll, listenAll } from './listen-hosts.js';
import { DB_PATH, TIMON_HOME } from './paths.js';
import { instanceId } from './host/packaged-service.js';
import { catchAsyncHandlers } from './kernel/async-routes.js';
import { createDataUpdate, ensureUpdateToken, mountDataUpdateRoutes } from './data-update.js';
import { DataSnapshotError, packagedDaemon, protectDataBeforeOpen, timonVersion, updateNeedsApproval } from './data-version.js';
import { holdDataOpenLock, releaseDataOpenLock } from './data-open-lock.js';

export async function waitForDataUpdate(): Promise<void> {
  if (!packagedDaemon()) return;
  const version = timonVersion();
  const files = { home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json') };
  let snapshotError: DataSnapshotError | undefined;
  if (!updateNeedsApproval(files, version)) {
    // Kept until db.ts has migrated: a packaged CLI approved at the same moment waits for both.
    holdDataOpenLock(TIMON_HOME);
    try { protectDataBeforeOpen(files, version); return; }
    catch (error) {
      releaseDataOpenLock(TIMON_HOME);
      if (!(error instanceof DataSnapshotError)) throw error;
      snapshotError = error;
    }
  }
  const cfg = loadConfig(undefined, { readonly: true });
  catchAsyncHandlers();
  const app = express();
  const token = ensureUpdateToken(TIMON_HOME);
  await new Promise<void>((resolve, reject) => {
    const update = createDataUpdate(files, version, { snapshotError, migrate: async () => {
      await import('./db.js');
      // Finish the approval response before handing this port to the normal boot.
      // EVERY socket: a `::1` left open would make the normal boot's secondary bind fail quietly.
      setImmediate(() => { void bound.then(closeAll).then(resolve, reject); });
    } });
    mountDataUpdateRoutes(app, update, token);
    // Public liveness only: supervisors must not roll back a healthy waiting process.
    app.get('/api/health', (_req, res) => {
      res.json({ ok: true, service: BRAND.id, instance: instanceId(TIMON_HOME), packaged: true, status: update.status().status === 'ready' ? 'starting' : 'update_pending' });
    });
    app.use((_req, res) => { res.status(503).json({ error: 'update_pending' }); });
    const bound = listenAll(app, cfg.daemon.listen.host, cfg.daemon.listen.port, console.warn, cfg.daemon.listen.extraHosts);
    bound.then(() => {
      console.log(`[data] Timon ${version} is waiting for update approval. Run timon update status.`);
    }, reject);
  });
}
