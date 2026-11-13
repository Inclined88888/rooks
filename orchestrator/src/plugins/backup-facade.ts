/**
 * `ctx.backup`: whether the nightly backup is on, what it has produced, and
 * switching it on — what `GET /api/backup/status` and `POST /api/backup/enable`
 * do, through the same functions.
 *
 * Only `enable` exists, never `disable`, nor a restore: turning the safety net
 * off or rolling the data back stays a human gesture. `enable` is idempotent
 * (it creates or re-arms the canonical 03:30 routine). In a request both are a
 * superadmin's, like the two routes (TODO #611, #627): an archive holds every
 * account's data and the status names where it lies. A job has no account to
 * outrank, and `backup:read` is sensitive: the operator consented at install.
 * The routine row itself (its prompt, agent) is not returned.
 */
import { backupStatus, enableBackupRoutine, type BackupStatus } from '../routines.js';
import { auditPluginAction, PluginAdminError, type AdminCallerScope } from './admin-support.js';

import type { PluginBackupStatus } from './contract/backup.js';
export type { PluginBackupArchive, PluginBackupStatus } from './contract/backup.js';

export type ScopedBackup = {
  status(): PluginBackupStatus;
  enable(): PluginBackupStatus;
};

function view(s: BackupStatus): PluginBackupStatus {
  return {
    enabled: s.enabled, cron: s.cron, keep: s.keep, maxAgeDays: s.max_age_days, dir: s.dir,
    lastRunAt: s.last_run_at, nextRunAt: s.next_run_at, archives: s.archives,
  };
}

export function backupFor(scope: AdminCallerScope): ScopedBackup {
  return {
    status() {
      if (!scope.job && !scope.superadmin) throw new PluginAdminError('forbidden', 'reading the backup status is for a superadmin');
      return view(backupStatus());
    },
    enable() {
      if (!scope.job && !scope.superadmin) throw new PluginAdminError('forbidden', 'enabling the backup is for a superadmin');
      let status: BackupStatus;
      try {
        status = enableBackupRoutine();
      } catch (err) {
        throw new PluginAdminError('unavailable', (err as Error).message);
      }
      auditPluginAction(scope, 'backup.enable', null);
      return view(status);
    },
  };
}
