/**
 * Recurring routines. A routine = (cron expression, agent, prompt,
 * task type) which, on each due tick, creates a standard **Kanban task**.
 *
 * Deliberately minimal: the routine does not spawn the agent itself;
 * it just injects the task into the Kanban and lets the dispatcher
 * do its job. Advantage: each run keeps a persistent trace
 * in the Kanban (audit, retry possible if BLOCKED, link
 * to the mission, etc.) — exactly what the user asked for:
 * "on each launch the routine creates the task in the Kanban before
 * running it so that we keep a trace".
 *
 * Exception: the built-in routine `rooks-backup-nightly` (step 4.6).
 * It calls `exportNova` in-process — spawning an LLM every night
 * to run `tar` would burn quota and miss the slot. The
 * trace is the archive under `$ROOKS_HOME/backups/`.
 *
 * Tick interval: 30s by default. A due routine runs only
 * once per tick: next_run_at is computed before creating the task,
 * so two coinciding ticks do not recreate the same task.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { db, dbApi, type RoutineRow, type TaskType } from './db.js';
import { exportNova, type ExportResult } from './export.js';
import { ROOKS_HOME } from './paths.js';
import { settingInt } from './settings.js';
import { scheduleCadenceProblem } from './triggers/schema.js';
import { recordDelivery } from './triggers/store.js';
import { assertSpawnAllowed } from './plugins/policy.js';
import { PLUGIN_OWNER_PREFIX } from './users/api-tokens.js';
import type { BackupArchive } from './plugins/contract/backup.js';
export type { BackupArchive } from './plugins/contract/backup.js';

const TICK_INTERVAL_MS = 30_000;

export type CreateRoutineInput = {
  name: string;
  agent_name: string;
  prompt: string;
  task_type?: TaskType;
  cron_expr: string;
  enabled?: boolean;
  project?: string | null;
  /** The account creating it; its tasks and missions run on its behalf. */
  ownerUserId?: string | null;
};

/** Computes the next tick of a cron expression. Throws if invalid. */
export function nextRunFromCron(expr: string, from: Date = new Date()): number {
  const it = CronExpressionParser.parse(expr, { currentDate: from });
  return it.next().getTime();
}

export function validateCron(expr: string): void {
  // Run and discard — if invalid, parse throws a readable error.
  CronExpressionParser.parse(expr);
  // Called on writes only (a routine re-read is never re-checked), hence the floor here.
  const tooOften = scheduleCadenceProblem(expr);
  if (tooOften) throw new Error(tooOften);
}

export function createRoutine(input: CreateRoutineInput): RoutineRow {
  validateCron(input.cron_expr);
  const id = randomUUID();
  const enabled = input.enabled ?? true;
  const nextAt = enabled ? nextRunFromCron(input.cron_expr) : null;
  dbApi.createRoutine({
    id,
    name: input.name,
    agent_name: input.agent_name,
    prompt: input.prompt,
    task_type: input.task_type ?? 'chore',
    cron_expr: input.cron_expr,
    enabled: enabled ? 1 : 0,
    project: input.project ?? null,
    owner_user_id: input.ownerUserId ?? null,
    last_run_at: null,
    next_run_at: nextAt,
  });
  const row = dbApi.getRoutine(id);
  if (!row) throw new Error('routine vanished post-insert');
  return row;
}

export function updateRoutine(
  id: string,
  fields: Partial<Omit<CreateRoutineInput, 'cron_expr'>> & { cron_expr?: string },
): RoutineRow {
  const row = dbApi.getRoutine(id);
  if (!row) throw new Error(`routine not found: ${id}`);
  // If the cron or enabled is touched, recompute next_run_at.
  let nextAt: number | null | undefined;
  const willBeEnabled = fields.enabled === undefined ? row.enabled === 1 : fields.enabled;
  const willBeCron = fields.cron_expr ?? row.cron_expr;
  // A cron kept as it was is not re-checked: a routine saved before the floor
  // must stay renamable and switchable off — not back on.
  const switchedOn = row.enabled !== 1 && willBeEnabled;
  if ((fields.cron_expr && fields.cron_expr !== row.cron_expr) || switchedOn) validateCron(willBeCron);
  if (fields.cron_expr !== undefined || fields.enabled !== undefined) {
    nextAt = willBeEnabled ? nextRunFromCron(willBeCron) : null;
  }
  dbApi.updateRoutine(id, {
    name: fields.name,
    agent_name: fields.agent_name,
    prompt: fields.prompt,
    task_type: fields.task_type,
    cron_expr: fields.cron_expr,
    enabled: fields.enabled,
    project: fields.project,
    next_run_at: nextAt,
  });
  return dbApi.getRoutine(id)!;
}

/** Stable id: `rooks backup enable` is idempotent, not a new UUID. */
export const BACKUP_ROUTINE_ID = 'rooks-backup-nightly';
export const BACKUP_CRON = '30 3 * * *';
/** Default of `ROOKS_BACKUP_KEEP`; the setting decides (`backupRetention`). */
export const BACKUP_KEEP = 7;
export const BACKUP_NAME = 'Backup nocturne';
/** Schema sentinel — never dispatched, the tick runs the export itself. */
export const BACKUP_AGENT = 'rooks';
const BACKUP_PROMPT =
  'rooks export --out ~/.rooks/backups/rooks-<date>.tar.gz every night at 03:30, '
  + 'then prune by ROOKS_BACKUP_KEEP and ROOKS_BACKUP_MAX_AGE_DAYS.';
const BACKUP_ARCHIVE_RE = /^rooks-(\d{4})-(\d{2})-(\d{2})\.tar\.gz$/;
const DAY_MS = 86_400_000;

export function backupsDir(home: string = ROOKS_HOME): string {
  return join(home, 'backups');
}

/** `rooks-YYYY-MM-DD.tar.gz` in local date — so is the 03:30 cron. */
export function backupArchiveName(when: Date = new Date()): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  return `rooks-${y}-${m}-${d}.tar.gz`;
}

export function listBackupArchives(dir: string = backupsDir()): BackupArchive[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_ARCHIVE_RE.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
}

/** How many archives to keep, and past what age (0 = none) to drop them. */
export type BackupRetention = { keep: number; maxAgeDays: number };

/**
 * Read at each prune, not at boot: a value changed in Settings applies to the
 * next backup without a restart. Bounds are enforced on write; a value forced
 * out of range through the environment falls back rather than deleting every
 * archive (`keep` 0) or none.
 */
export function backupRetention(): BackupRetention {
  const keep = settingInt('ROOKS_BACKUP_KEEP');
  const maxAgeDays = settingInt('ROOKS_BACKUP_MAX_AGE_DAYS');
  return {
    keep: Number.isInteger(keep) && keep >= 1 ? keep : BACKUP_KEEP,
    maxAgeDays: Number.isInteger(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 0,
  };
}

/** Local midnight of the day an archive name carries (the cron is local too). */
function archiveDay(name: string): number | null {
  const m = BACKUP_ARCHIVE_RE.exec(name);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * Keeps the `keep` newest archives (name order = date order) and drops those
 * older than `maxAgeDays`. The newest archive survives both rules: a clock set
 * wrong, or a max age shorter than the gap since the last backup, must never
 * leave the folder empty. Returns the names removed.
 */
export function pruneBackupArchives(
  dir: string = backupsDir(),
  retention: number | BackupRetention = backupRetention(),
  now: Date = new Date(),
): string[] {
  const { keep, maxAgeDays } = typeof retention === 'number' ? { keep: retention, maxAgeDays: 0 } : retention;
  const cutoff = maxAgeDays > 0 ? now.getTime() - maxAgeDays * DAY_MS : null;
  const dropped: string[] = [];
  listBackupArchives(dir).forEach((file, index) => {
    if (index === 0) return;
    const day = archiveDay(file.name);
    const tooMany = index >= Math.max(1, keep);
    const tooOld = cutoff !== null && day !== null && day < cutoff;
    if (!tooMany && !tooOld) return;
    rmSync(join(dir, file.name));
    dropped.push(file.name);
  });
  return dropped;
}

export type BackupStatus = {
  enabled: boolean;
  cron: string;
  keep: number;
  /** 0 = no age limit. */
  max_age_days: number;
  dir: string;
  last_run_at: number | null;
  next_run_at: number | null;
  archives: BackupArchive[];
  routine: RoutineRow | null;
};

export function backupStatus(): BackupStatus {
  const row = dbApi.getRoutine(BACKUP_ROUTINE_ID) ?? null;
  const retention = backupRetention();
  return {
    enabled: row?.enabled === 1,
    cron: row?.cron_expr ?? BACKUP_CRON,
    keep: retention.keep,
    max_age_days: retention.maxAgeDays,
    dir: backupsDir(),
    last_run_at: row?.last_run_at ?? null,
    next_run_at: row?.next_run_at ?? null,
    archives: listBackupArchives(),
    routine: row,
  };
}

/** Idempotent: creates or re-enables the canonical 03:30 routine. */
export function enableBackupRoutine(): BackupStatus {
  const existing = dbApi.getRoutine(BACKUP_ROUTINE_ID);
  if (existing) {
    updateRoutine(BACKUP_ROUTINE_ID, {
      name: BACKUP_NAME,
      agent_name: BACKUP_AGENT,
      prompt: BACKUP_PROMPT,
      task_type: 'chore',
      cron_expr: BACKUP_CRON,
      enabled: true,
      project: null,
    });
  } else {
    validateCron(BACKUP_CRON);
    dbApi.createRoutine({
      id: BACKUP_ROUTINE_ID,
      name: BACKUP_NAME,
      agent_name: BACKUP_AGENT,
      prompt: BACKUP_PROMPT,
      task_type: 'chore',
      cron_expr: BACKUP_CRON,
      enabled: 1,
      project: null,
      last_run_at: null,
      next_run_at: nextRunFromCron(BACKUP_CRON),
    });
    if (!dbApi.getRoutine(BACKUP_ROUTINE_ID)) {
      throw new Error('backup routine vanished post-insert');
    }
  }
  mkdirSync(backupsDir(), { recursive: true });
  return backupStatus();
}

/**
 * Marker of the one-time default (TODO #476): once set, the boot never touches
 * the backup routine again. That is what tells "never configured" from "the
 * user turned it off": a routine row disabled, or deleted, after the marker
 * stays as the user left it.
 */
export const BACKUP_DEFAULT_KEY = 'backup.default_on.applied_at';

/**
 * The backup is on by default, on new installs as on existing ones. Runs at
 * every boot of the routines module and acts once: no routine row yet → it is
 * created enabled; a row already there (enabled or disabled by someone) is
 * left alone. A failure leaves the marker unset, so the next boot retries.
 */
export function applyBackupDefault(): 'created' | 'kept' | 'already' {
  if (dbApi.getAllSettings()[BACKUP_DEFAULT_KEY]) return 'already';
  const outcome = dbApi.getRoutine(BACKUP_ROUTINE_ID) ? 'kept' : 'created';
  if (outcome === 'created') enableBackupRoutine();
  dbApi.setSetting(BACKUP_DEFAULT_KEY, String(Date.now()));
  return outcome;
}

/**
 * Archive under `$ROOKS_HOME/backups/` (never a test's real `~/.rooks`:
 * `ROOKS_HOME` is the process's). Secrets excluded, like `rooks export`.
 */
export function runNightlyBackup(when: Date = new Date()): ExportResult {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const result = exportNova({
    out: join(dir, backupArchiveName(when)),
    home: ROOKS_HOME,
    vacuumInto: (dest) => {
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    },
  });
  // `when` is the clock of this backup: the age limit counts from it.
  const pruned = pruneBackupArchives(dir, backupRetention(), when);
  if (pruned.length) console.log(`[routines] backup prune: ${pruned.join(', ')}`);
  return result;
}

/**
 * Tick: for each due routine, creates a Kanban task and moves
 * next_run_at to the next occurrence of the cron. Non-fatal on an individual
 * error: log and carry on with the others.
 *
 * The backup routine opens NO task: the export runs here.
 */
export async function tickRoutines(): Promise<void> {
  const due = dbApi.listDueRoutines();
  for (const r of due) {
    const now = Date.now();
    try {
      if (r.id === BACKUP_ROUTINE_ID) {
        const result = runNightlyBackup();
        console.log(`[routines] backup ${result.out} (${result.bytes} octets)`);
        recordDelivery({ triggerId: r.id, status: 'received', reason: `backup ${result.bytes} bytes` });
      } else {
        // A plugin's routine ticks with nobody in front: each task it opens is
        // a spawn of that plugin, held to its approval and quota (TODO #591).
        // A refusal skips this tick (the catch below logs it and moves on).
        if (r.owner_user_id?.startsWith(PLUGIN_OWNER_PREFIX)) {
          assertSpawnAllowed(r.owner_user_id.slice(PLUGIN_OWNER_PREFIX.length), now, 'ctx.routines');
        }
        const taskId = randomUUID();
        dbApi.createTask(taskId, r.name, r.agent_name, {
          description: r.prompt,
          type: r.task_type,
          priority: 3,
          // The routine's creator: the task, and the mission it starts, run on
          // that account's behalf.
          ownerUserId: r.owner_user_id,
        });
        dbApi.setTaskRoutine(taskId, r.id);
        console.log(`[routines] ${r.id} (${r.name}) → task ${taskId}`);
        recordDelivery({ triggerId: r.id, status: 'received', result: [{ type: 'task', ok: true, id: taskId }] });
      }
      // Moves next_run_at forward — based on "now" so that a routine
      // whose orchestrator was down does not catch up in bursts.
      let nextAt: number;
      try { nextAt = nextRunFromCron(r.cron_expr); }
      catch { nextAt = now + 60_000; /* fallback: retry in 1 min */ }
      dbApi.markRoutineRun(r.id, now, nextAt);
    } catch (err) {
      console.error(`[routines] tick failed for ${r.id}:`, (err as Error).message);
      recordDelivery({ triggerId: r.id, status: 'error', reason: (err as Error).message });
      // Move next_run_at forward anyway so as not to loop on the same
      // broken routine on every tick (30s).
      try {
        const nextAt = nextRunFromCron(r.cron_expr);
        dbApi.markRoutineRun(r.id, now, nextAt);
      } catch { /* */ }
    }
  }
}

export function startRoutines(): () => void {
  try {
    if (applyBackupDefault() === 'created') console.log('[routines] nightly backup enabled by default (03:30)');
  } catch (err) {
    console.warn(`[routines] default backup not enabled: ${(err as Error).message}`);
  }
  // Catches up NULL next_run_at from a migration from an old version,
  // or routines created without next_run_at (odd cases).
  for (const r of dbApi.listRoutines()) {
    if (r.enabled === 1 && r.next_run_at === null) {
      try {
        const nextAt = nextRunFromCron(r.cron_expr);
        dbApi.markRoutineRun(r.id, r.last_run_at ?? Date.now(), nextAt);
      } catch (err) {
        console.warn(`[routines] invalid cron for ${r.id}: ${(err as Error).message}`);
      }
    }
  }
  // First tick immediately, then the interval.
  tickRoutines().catch((err) => console.error('[routines] initial tick error:', err));
  const timer = setInterval(() => {
    tickRoutines().catch((err) => console.error('[routines] tick error:', err));
  }, TICK_INTERVAL_MS);
  console.log(`[routines] started (interval=${TICK_INTERVAL_MS}ms)`);
  return () => clearInterval(timer);
}
