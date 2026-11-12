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
  rooksVersion,
  watchRestoreRequest,
} from './data-version.js';
import { DB_PATH, ROOKS_HOME } from './paths.js';

if (packagedDaemon()) {
  const version = rooksVersion();
  const files = { home: ROOKS_HOME, dbPath: DB_PATH, configPath: join(ROOKS_HOME, 'rooks.config.json') };
  // Throws when an interrupted restore cannot be undone: db.ts must not open that.
  const result = applyPendingRestore(files, version);
  if (result?.ok) console.log(`[data] restored ${result.snapshot}`);
  else if (result) console.error(`[data] could not restore ${result.snapshot}: ${result.error}`);
  watchRestoreRequest(ROOKS_HOME, version, () => {
    console.warn('[data] a restore was requested: restarting to apply it');
    process.exit(RESTORE_EXIT_CODE);
  });
}
