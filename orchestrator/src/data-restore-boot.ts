/**
 * First import of `boot.ts`, on purpose: ES modules run in import order, so
 * this applies a requested restore before `db.ts` opens the database. Only the
 * daemon imports `boot.ts` — never the CLI or the desktop helpers, which may
 * run while another daemon holds the database.
 */
import { join } from 'node:path';
import {
  RESTORE_EXIT_CODE,
  applyPendingRestore,
  packagedDaemon,
  timonVersion,
  watchRestoreRequest,
} from './data-version.js';
import { DB_PATH, TIMON_HOME } from './paths.js';

if (packagedDaemon()) {
  const version = timonVersion();
  const files = { home: TIMON_HOME, dbPath: DB_PATH, configPath: join(TIMON_HOME, 'timon.config.json') };
  // Throws when an interrupted restore cannot be undone: db.ts must not open that.
  const result = applyPendingRestore(files, version);
  if (result?.ok) console.log(`[data] restored ${result.snapshot}`);
  else if (result) console.error(`[data] could not restore ${result.snapshot}: ${result.error}`);
  watchRestoreRequest(TIMON_HOME, version, () => {
    console.warn('[data] a restore was requested: restarting to apply it');
    process.exit(RESTORE_EXIT_CODE);
  });
}
