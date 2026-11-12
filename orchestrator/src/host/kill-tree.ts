/**
 * Stops a child and what it started.
 *
 * On Windows a shim the adapter cannot start directly runs through `cmd.exe`
 * (`windows-shell.ts`): `child.kill()` ends `cmd.exe` and leaves the real node
 * process running. `taskkill /T` takes the whole tree, as long as the root is
 * still there to walk down from: the root is ended once it has answered. Elsewhere
 * the signal reaches the CLI itself, which is enough for the login flows that use
 * this (`backends/account-login.ts`).
 *
 * POSIX has a stronger answer for a child started with `detached`: its process
 * group. The table of `process-tree.ts` cannot do this job: once a program has
 * exited, what it left behind is reparented and no parent pid leads to it any
 * more, whereas the group still holds it and the kernel signals it atomically.
 *
 * Never throws: the child may already be gone.
 */
import type { ChildProcess } from 'node:child_process';
import { getHost } from './index.js';
import type { ExecResult, SpawnOpts } from './types.js';

/**
 * How long the root waits for `taskkill`. Under the shortest grace of a caller
 * (`session-one-shot`, 2 s), whose forced kill stays the last resort. `taskkill`
 * keeps its own longer limit: past this wait it may still finish what it started.
 */
const TASKKILL_WAIT_MS = 1_500;

/**
 * Returns at once on every platform: on Windows the root ends a little later, and
 * a caller that needs it gone waits for its `exit`. `taskkill` is started before
 * this returns, so a daemon exiting right after still takes the tree.
 */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const endRoot = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
  if (platform !== 'win32' || !child.pid) { endRoot(); return; }
  // `exit` can precede `close`: Windows may already have reused the root's pid.
  if (child.exitCode !== null || child.signalCode !== null) return;
  const answer = getHost().execAsync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { timeout: 5_000, windowsHide: true });
  let ended = false;
  const endOnce = () => {
    if (ended) return;
    ended = true;
    clearTimeout(wait);
    endRoot();
  };
  const wait = setTimeout(endOnce, TASKKILL_WAIT_MS);
  wait.unref();
  // A failed `taskkill` is no reason to spare the root.
  answer.then(endOnce, endOnce);
}

/**
 * Signals the group of a child started with `detached: true` (POSIX), and falls
 * back on `killProcessTree` where there is no group: Windows, or a group gone.
 */
export function stopProcessGroup(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  // Negative pid = the group `detached` gave it. Never 0, which is our own
  // group, nor 1: -1 reaches every process this user may signal.
  if (platform !== 'win32' && pid !== undefined && pid > 1) {
    try { process.kill(-pid, signal); return; } catch { /* already gone, or no group */ }
  }
  killProcessTree(child, platform);
}

/** What a program that left the group keeps open is given this long after its exit. */
const DRAIN_MS = 250;

export type ExecTreeOpts = Pick<SpawnOpts, 'cwd' | 'env'> & { timeout: number; maxBuffer: number };

/**
 * `detached` takes the child out of the daemon's group and session: a Ctrl+C at
 * the terminal no longer reaches it, nor does launchd's group kill. The daemon
 * ends on SIGTERM and SIGINT through `process.exit` (`resources-guard`), so this
 * brings back what those signals did. A SIGKILLed daemon still leaves the child.
 */
const liveGroups = new Set<ChildProcess>();
let exitHooked = false;
function trackGroup(child: ChildProcess): void {
  liveGroups.add(child);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => { for (const live of liveGroups) stopProcessGroup(live, 'SIGKILL'); });
}

/**
 * `execAsync` for a program that is only asked a question, whose limit and exit
 * also end what it started. Two differences that are the point of it: the answer
 * returns when the program exits, not when the last holder of its stdout lets go;
 * and nothing it left in its group outlives the call. SIGKILL, because a program
 * that ignores SIGTERM must not hold the caller. A child that left the group on
 * purpose (`setsid`, a detached updater) is not ours to end, and is left alone.
 *
 * Windows has no group: the limit takes the tree through `taskkill /T`, but a
 * program that already exited gives no way to find what it left, and its pid may
 * already be someone else's. The call still returns; the child stays.
 *
 * Same contract as `execAsync`: rejects only for a binary that does not resolve.
 */
export function execTree(name: string, args: string[], opts: ExecTreeOpts): Promise<ExecResult> {
  return new Promise((resolve) => {
    const host = getHost();
    // `spawn` would fall back on the bare name and report ENOENT by event.
    host.bin(name);
    // Off on Windows, where `detached` opens a console window.
    const grouped = host.platform !== 'win32';
    const child = host.spawn(name, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: grouped,
    });
    if (grouped && child.pid) trackGroup(child);

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let overflowed = false;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      liveGroups.delete(child);
      stopProcessGroup(child, 'SIGKILL', host.platform);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(drain);
      liveGroups.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: overflowed ? 1 : exitCode ?? 1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    };
    // `close` normally comes first. This is for a holder outside the group, or a
    // process the kernel cannot end right now: the caller returns regardless.
    const drainThenSettle = () => { drain ??= setTimeout(settle, DRAIN_MS); };

    const limit = setTimeout(() => {
      timedOut = true;
      stop();
      drainThenSettle();
    }, opts.timeout);

    const keep = (held: string, chunk: string): string => {
      const next = held + chunk;
      if (next.length <= opts.maxBuffer) return next;
      overflowed = true;
      stop();
      drainThenSettle();
      return next.slice(0, opts.maxBuffer);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout = keep(stdout, chunk); });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = keep(stderr, chunk); });

    child.on('error', settle);
    child.on('exit', (code) => {
      exitCode = code;
      clearTimeout(limit);
      // At once: the group outlives its leader only as long as it has members,
      // and an empty group's number can come back. Never `taskkill` here: on
      // Windows this pid may already belong to another process.
      if (grouped) stop();
      else liveGroups.delete(child);
      drainThenSettle();
    });
    child.on('close', settle);
  });
}
