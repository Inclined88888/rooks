/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `routines.ts`, which re-exports it (TODO #512, volet 3).
export type BackupArchive = { name: string; bytes: number };

export type PluginBackupArchive = BackupArchive;

export type PluginBackupStatus = {
  enabled: boolean;
  /** Cron expression of the backup routine. */
  cron: string;
  /** How many archives are kept (setting `TIMON_BACKUP_KEEP`). */
  keep: number;
  /** Archives older than this many days are dropped; 0 = no age limit. */
  maxAgeDays: number;
  /** Folder of the archives, on the machine. */
  dir: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /** Newest first. */
  archives: PluginBackupArchive[];
};
