/**
 * Supervision of the grepai watchers (local semantic index, one per project).
 *
 * Context: `grepai search` serves as a semantic index for the ROOKS agents, but its
 * index only updates if `grepai watch` runs in the project's cwd.
 * Without a watcher, the index freezes silently — the agents then get back
 * code that no longer exists, which is worse than no index at all since they
 * trust it. Hence this module: making the watcher's state visible and
 * actionable from the UI.
 *
 * Source of truth = /proc, not a home-made pid table. A watcher launched by
 * hand outside ROOKS is therefore detected, and an orchestrator restart does not lose
 * the state. The whole thing is Linux-only, which is a given in host mode.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHost } from './host/index.js';
import { projectDir } from './paths.js';
import { listProjects, readMeta, writeMeta } from './projects.js';
import { reportOf, resolveProjectCwd, type CwdReport } from './project-cwd.js';

/** Files written by grepai in `<cwd>/.grepai/`. `index.gob` carries the
 *  vectors — its mtime is the best freshness proxy available. */
const INDEX_FILE = 'index.gob';

export type WatcherState =
  /** living watcher → index kept up to date in real time */
  | 'running'
  /** `.grepai/` present but no watcher → drifting index */
  | 'stopped'
  /** project never indexed (no `.grepai/`) */
  | 'not-indexed'
  /** project meta without a `cwd`, or unusable cwd (see `cwd_error`) */
  | 'no-cwd';

/** Supervision intent, persisted in the DB (`projects.grepai_watch`).
 *  Without it, a deliberate stop from the UI would be undone by the next
 *  reconciliation pass — the "Stop" button would be useless. */
export type WatcherDesired = 'auto' | 'off';

export type WatcherStatus = CwdReport & {
  slug: string;
  state: WatcherState;
  /** 'auto' → reconciliation relaunches this watcher if it is dead; 'off' →
   *  deliberate stop, it is left alone. Default 'auto'. */
  desired: WatcherDesired;
  cwd: string | null;
  /** `<cwd>/.grepai/` exists → the project is under grepai, even if the index
   *  has not been written yet. Lets the UI show the block only for
   *  the projects concerned, without inferring it from `state`. */
  has_grepai: boolean;
  /** pid of the detected `grepai watch`, null if none */
  pid: number | null;
  /** mtime epoch ms of `.grepai/index.gob`, null if no index */
  indexed_at: number | null;
  /** age of the index in ms — handy for display, avoids a UI clock skew */
  index_age_ms: number | null;
  /** size of the index in bytes (reveals an empty/corrupted index) */
  index_bytes: number | null;
};

/** Window for waiting on the process to appear after `systemd-run`. */
const START_TIMEOUT_MS = 3000;
const START_POLL_MS = 100;

/** Table pid → cwd of the `grepai watch` currently alive.
 *  A single sweep of /proc for all the projects: listStatuses() is called
 *  in a loop by the UI, one scan per project would cost N times more. */
function scanWatchers(): Map<string, number> {
  const byCwd = new Map<string, number>();
  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return byCwd; }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      // cmdline is NUL-separated; the args are kept to tell `watch` from a `search`.
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8'); // portability: Linux procfs; readdirSync('/proc') above fails first elsewhere
    } catch { continue; /* process gone between readdir and read */ }

    const args = cmdline.split('\0').filter(Boolean);
    const [exe, sub] = args;
    if (!exe || sub !== 'watch') continue;
    if ((exe.split('/').pop() ?? '') !== 'grepai') continue;

    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      // First one wins: if two watchers run on the same cwd (double
      // manual launch), only one is exposed — stop will kill them one after the other.
      if (!byCwd.has(cwd)) byCwd.set(cwd, Number(entry));
    } catch { /* no rights or dead process → ignored */ }
  }
  return byCwd;
}

/** Intent read from the DB. Any value other than 'off' means 'auto': the default
 *  of a project never touched must be "supervise it", otherwise the resume after
 *  a reboot would only cover the projects already started once through the UI. */
function readDesired(slug: string): WatcherDesired {
  return readMeta(slug).grepai_watch === 'off' ? 'off' : 'auto';
}

function writeDesired(slug: string, desired: WatcherDesired): void {
  if (readDesired(slug) === desired) return;
  writeMeta(slug, { grepai_watch: desired });
}

function buildStatus(slug: string, watchers: Map<string, number>, now: number): WatcherStatus {
  const desired = readDesired(slug);
  const resolved = resolveProjectCwd(slug);
  const cwd = resolved.cwd;
  if (!cwd) {
    return {
      slug, state: 'no-cwd', desired, cwd: null, ...reportOf(resolved), has_grepai: false, pid: null,
      indexed_at: null, index_age_ms: null, index_bytes: null,
    };
  }

  const pid = watchers.get(cwd) ?? null;
  const has_grepai = existsSync(join(cwd, '.grepai'));
  const indexPath = join(cwd, '.grepai', INDEX_FILE);
  let indexed_at: number | null = null;
  let index_bytes: number | null = null;
  try {
    const st = statSync(indexPath);
    indexed_at = st.mtimeMs;
    index_bytes = st.size;
  } catch { /* no index */ }

  // A living watcher wins: it may have just started its initial scan,
  // in which case the index does not exist yet but the state is not "not indexed".
  const state: WatcherState = pid !== null ? 'running' : indexed_at === null ? 'not-indexed' : 'stopped';

  return {
    slug,
    state,
    desired,
    cwd,
    ...reportOf(resolved),
    has_grepai,
    pid,
    indexed_at,
    index_age_ms: indexed_at === null ? null : Math.max(0, now - indexed_at),
    index_bytes,
  };
}

/** Status of all the known projects, sorted by ascending slug. */
export function listStatuses(): WatcherStatus[] {
  const watchers = scanWatchers();
  const now = Date.now();
  return listProjects()
    .map((slug) => buildStatus(slug, watchers, now))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getStatus(slug: string): WatcherStatus {
  return buildStatus(slug, scanWatchers(), Date.now());
}

/** Name of the transient systemd unit carrying a project's watcher. */
export function watcherUnit(slug: string): string {
  return `grepai-watch-${slug}`;
}

/** Launches `grepai watch` in the project's cwd, through a transient systemd unit.
 *
 *  Why systemd-run and not a mere detached spawn: the orchestrator runs
 *  under a unit with `KillMode=control-group` (the default). A `systemctl restart
 *  rooks-orchestrator` therefore SIGTERMs its WHOLE cgroup. `detached: true` opens a
 *  new process session but does NOT leave the cgroup — a watcher
 *  spawned directly would die at every redeployment, which is exactly the
 *  failure this module must remove. `systemd-run --user` puts the watcher
 *  in its own unit, hence its own cgroup, and it survives.
 *
 *  `--collect`: systemd cleans the unit up when it stops, otherwise a `failed`
 *  unit would remain and block the next start under the same name.
 *
 *  Idempotent: if a watcher already runs on this cwd, its status is returned
 *  without relaunching anything (two watchers on the same index would step on each other). */
export async function startWatcher(slug: string): Promise<WatcherStatus> {
  let current = getStatus(slug);
  if (current.state === 'no-cwd') throw new Error(`project "${slug}" has no usable cwd`);
  // A start counts as consent to supervision: reconciliation takes
  // this project back over (and will relaunch it at the next boot).
  writeDesired(slug, 'auto');
  attempts.delete(slug);
  current = getStatus(slug);
  if (current.state === 'running') return current;

  // The project folder may not exist (project known by the DB alone).
  mkdirSync(projectDir(slug), { recursive: true });

  getHost().services.start(watcherUnit(slug), 'grepai', ['watch'], current.cwd!);

  // systemd-run returns before the child process is visible in
  // /proc; without this short wait, the returned status would say "stopped"
  // right after a successful start.
  const deadline = Date.now() + START_TIMEOUT_MS;
  let status = getStatus(slug);
  while (status.state !== 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, START_POLL_MS));
    status = getStatus(slug);
  }
  return status;
}

/** Window for waiting on the process's actual death after SIGTERM. */
const STOP_TIMEOUT_MS = 3000;
const STOP_POLL_MS = 100;

/** true as long as the pid still exists. `kill(pid, 0)` signals nothing, it tests. */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Stops the project's watcher. SIGTERM to let grepai flush its index
 *  cleanly — a SIGKILL during a .gob write would leave a corrupted index.
 *
 *  The actual death is awaited before reading the status again: /proc still exposes
 *  the process for the few dozen ms that follow the signal, and
 *  returning `running` right after a stop would show a wrong state in the UI.
 *
 *  Idempotent: no watcher → simply returns the current status. */
export async function stopWatcher(slug: string): Promise<WatcherStatus> {
  // A stop is ALWAYS deliberate (no automatic caller): it is
  // memorised even before signalling the process, so that a concurrent
  // reconciliation pass does not relaunch it right away.
  writeDesired(slug, 'off');
  const current = getStatus(slug);
  if (current.pid === null) return current;

  // Nominal path: the transient unit we created. `services.stop` also removes
  // the unit, otherwise a later `systemd-run` with the same name would fail.
  getHost().services.stop(watcherUnit(slug));
  // Fallback: watcher launched by hand outside systemd (detected by the /proc scan),
  // hence without a unit to stop — the pid is signalled directly.
  if (isAlive(current.pid)) {
    try { process.kill(current.pid, 'SIGTERM'); } catch { /* already dead */ }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(current.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
  // Beyond the delay the real state is returned rather than forcing a SIGKILL:
  // a lingering watcher is less serious than a truncated index, and the next
  // UI poll will show it is still running.
  return getStatus(slug);
}

/** `grepai init` in the project's cwd, then start of the watcher.
 *
 *  Both are chained on purpose: `init` only writes a
 *  `.grepai/config.yaml`, no index. It is the watcher's initial scan that
 *  really builds the index — stopping after `init` would leave a project
 *  "under grepai" whose every search would return nothing, exactly the
 *  false positive we seek to eliminate.
 *
 *  Idempotent: an already initialised project goes straight to starting the
 *  watcher (`init` would refuse to rewrite the config). */
export async function initProject(slug: string): Promise<WatcherStatus> {
  const current = getStatus(slug);
  if (current.state === 'no-cwd') throw new Error(`project "${slug}" has no usable cwd`);

  if (!current.has_grepai) {
    const r = getHost().exec('grepai', ['init'], { cwd: current.cwd! });
    if (r.code !== 0) {
      throw new Error(`grepai init failed: ${(r.stderr || r.stdout).trim() || `code ${r.code}`}`);
    }
  }
  return startWatcher(slug);
}

/** Deletes the grepai index entirely then rebuilds it from scratch.
 *
 *  This action is deliberately distinct from a mere restart: a
 *  corrupted index or a stuck scan would survive the watcher's restart. `.grepai`
 *  is never deleted while the process is alive, because it could
 *  recreate files in the middle of the following initialisation. */
export async function rebuildProject(slug: string): Promise<WatcherStatus> {
  const current = getStatus(slug);
  if (current.state === 'no-cwd') throw new Error(`project "${slug}" has no usable cwd`);

  const stopped = await stopWatcher(slug);
  if (stopped.pid !== null) {
    throw new Error('the grepai watcher did not stop; index kept to be safe');
  }

  rmSync(join(current.cwd!, '.grepai'), { recursive: true, force: true });
  return initProject(slug);
}

/* ── Reconciliation ────────────────────────────────────────────────────────
   The watchers run in TRANSIENT systemd units (`systemd-run
   --collect`): they are not persisted, so a reboot of the machine erases
   them all. Nothing relaunched them — on waking up, every index was
   frozen and one had to click project by project in the UI. This rule
   rebuilds the expected state: "every indexed and not disabled project has a
   living watcher". */

/** Consecutive relaunch attempts per project, reset to zero as soon as the
 *  watcher is seen alive. A watcher that dies as soon as relaunched (broken
 *  binary, unreadable repo) would otherwise be respawned every 2 min forever. */
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

/** Delay between two starts. grepai's initial scan is heavy (local
 *  embeddings): launching 7 watchers at once at boot brings the machine to its knees at
 *  the very moment the user has just switched it back on. */
const STAGGER_MS = 5000;

/** A single pass at a time: the boot pass can last several dozen
 *  seconds (stagger), the interval must not overlap it. */
let reconciling = false;

export async function reconcileWatchers(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    let started = 0;
    for (const w of listStatuses()) {
      if (w.state === 'running') { attempts.delete(w.slug); continue; }
      // `not-indexed` is excluded on purpose: starting a watcher on a
      // project never initialised (`grepai init`) is the user's decision, not
      // bringing things back into line — and its initial scan is expensive.
      if (w.state !== 'stopped' || w.desired === 'off') continue;

      const tries = attempts.get(w.slug) ?? 0;
      if (tries >= MAX_ATTEMPTS) continue;

      if (started > 0) await new Promise((r) => setTimeout(r, STAGGER_MS));
      started++;
      // The counter is set AFTER the call: `startWatcher` resets it to zero
      // (an explicit start erases the failure history), so incrementing it
      // before would be pointless.
      try {
        const status = await startWatcher(w.slug);
        if (status.state === 'running') {
          console.log(`[grepai] watcher restarted — ${w.slug} (pid ${status.pid})`);
          continue;
        }
      } catch (err) {
        console.warn(`[grepai] restart of ${w.slug} failed: ${(err as Error).message}`);
      }
      attempts.set(w.slug, tries + 1);
      if (tries + 1 >= MAX_ATTEMPTS) {
        console.warn(`[grepai] watcher ${w.slug} keeps dying after ${MAX_ATTEMPTS} attempts — giving up until the next manual start`);
      }
    }
  } finally {
    reconciling = false;
  }
}

/** Last log lines of the watcher (diagnosis from the UI).
 *  The watcher running under a systemd unit, its output goes to the journal — not
 *  into a file we would manage (and would have to rotate) ourselves. */
export function tailWatcherLog(slug: string, lines = 40): string {
  try {
    const r = getHost().exec(
      'journalctl',
      ['--user', '-u', watcherUnit(slug), '-n', String(lines), '--no-pager', '-o', 'cat'],
    );
    return r.code === 0 ? r.stdout.trim() : '';
  } catch {
    // Host without journald: no log to show, it is not an error.
    return '';
  }
}
