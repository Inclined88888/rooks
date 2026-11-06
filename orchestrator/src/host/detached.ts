/**
 * Launching a process that must OUTLIVE the daemon — and the service manager
 * that stops it. First user: the terminal host (`src/terminal-host/`), which
 * keeps the web terminal's shells across a daemon restart.
 *
 * A plain `spawn` is not enough on any OS, for a different reason on each:
 *
 * - Linux: the service runs with `KillMode=control-group`. `systemctl
 *   restart` signals the whole cgroup, and `detached: true` (a new session)
 *   does not leave it. Only a unit of its own does: `systemd-run --user
 *   --scope` (see `openTerminal` in `src/terminal.ts`, same trap).
 * - macOS: launchd kills the job's process GROUP when it stops it (unless the
 *   plist sets `AbandonProcessGroup`). A new session (`setsid`, what
 *   `detached: true` does on POSIX) is a new group, out of reach.
 * - Windows: libuv puts every non-detached child in a job object that dies
 *   with the parent, and stopping the service runs `taskkill /F /T` on its
 *   launcher, which walks the tree by parent pid. So the process is started
 *   detached BY AN INTERMEDIATE that exits at once (`detach-runner.ts`): its
 *   parent pid then names a dead process, and no tree reaches it.
 *
 * Without systemd on Linux (a container, WSL without it) the new session is
 * the fallback: it survives a supervisor that signals the main pid or its
 * group, not one that empties a cgroup or stops the container.
 *
 * Output goes to a log file, never to a pipe back to the daemon: the pipe
 * would break (EPIPE) the moment the daemon dies, which is the whole point.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DetachedSpec = {
  cmd: string;
  args: string[];
  /** Complete environment of the process, passed verbatim. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** stdout and stderr, appended. */
  logFile: string;
  /** Readable prefix for a unit or a log line: `timon-terminal-host`. */
  name: string;
};

export type DetachedResult = {
  pid: number | null;
  /** How it escaped the supervisor — reported in the daemon log and the status. */
  via: 'systemd-scope' | 'new-session' | 'orphan';
};

const LOG_ROTATE_BYTES = 1024 * 1024;

/** Opens the log for appending, after moving a large one aside. */
export function openLog(file: string): number {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch { /* no log yet */ }
  return openSync(file, 'a', 0o600);
}

/** Resolves once the child exists, rejects if it could not start at all. */
function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
}

/** POSIX: a new session, hence a new process group. */
export async function spawnInNewSession(spec: DetachedSpec): Promise<DetachedResult> {
  const fd = openLog(spec.logFile);
  try {
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    await started(child);
    child.unref();
    return { pid: child.pid ?? null, via: 'new-session' };
  } finally {
    closeSync(fd);
  }
}

/** How long a failing `systemd-run` takes to say so; the host itself never exits that fast with an error. */
const SCOPE_FAILURE_WINDOW_MS = 750;

/**
 * Linux with a user manager: a transient scope of its own. A scope runs the
 * command in place and inherits the caller's environment, unlike a service
 * unit. Not in the missions' slice: its memory pressure kills there.
 */
export async function spawnInScope(spec: DetachedSpec): Promise<DetachedResult> {
  const unit = `${spec.name}-${randomBytes(4).toString('hex')}`;
  const fd = openLog(spec.logFile);
  let child: ChildProcess;
  try {
    child = spawn('systemd-run', ['--user', '--scope', '--collect', '--quiet', `--unit=${unit}`, '--', spec.cmd, ...spec.args], {
      cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', fd, fd],
    });
    await started(child);
  } catch {
    closeSync(fd);
    return spawnInNewSession(spec);
  }
  closeSync(fd);
  const early = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), SCOPE_FAILURE_WINDOW_MS);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
  child.unref();
  if (early !== null && early !== 0) {
    console.warn(`[host] systemd-run --scope refused ${spec.name} (exit ${early}); falling back to a new session, which a service restart may still reach`);
    return spawnInNewSession(spec);
  }
  return { pid: child.pid ?? null, via: 'systemd-scope' };
}

export type OrphanRuntime = {
  /** Node (or Electron as Node) that runs the intermediate. */
  execPath: string;
  execArgv: string[];
  runner: string;
};

export function defaultOrphanRuntime(): OrphanRuntime {
  return { execPath: process.execPath, execArgv: [], runner: fileURLToPath(new URL('./detach-runner.js', import.meta.url)) };
}

/** Name of the variable that carries the spec to `detach-runner.ts`. */
export const DETACH_SPEC_ENV = 'TIMON_DETACH_SPEC';

/**
 * Windows: started by an intermediate that exits at once. The intermediate
 * prints the final pid; the spec travels in the environment because it holds
 * paths a command line would have to quote for cmd's rules.
 */
export async function spawnOrphan(spec: DetachedSpec, runtime: OrphanRuntime = defaultOrphanRuntime()): Promise<DetachedResult> {
  const payload = JSON.stringify({ cmd: spec.cmd, args: spec.args, cwd: spec.cwd, logFile: spec.logFile });
  const child = spawn(runtime.execPath, [...runtime.execArgv, runtime.runner], {
    cwd: spec.cwd,
    env: { ...spec.env, [DETACH_SPEC_ENV]: payload },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (d: string) => { out += d; });
  child.stderr?.setEncoding('utf8').on('data', (d: string) => { err += d; });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`could not start ${spec.name}: ${err.trim() || `exit ${code}`}`);
  const pid = Number(out.trim());
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, via: 'orphan' };
}

/** The strategy of a host without systemd: orphan on Windows, new session elsewhere. */
export function spawnDetachedGeneric(spec: DetachedSpec, platform: NodeJS.Platform = process.platform): Promise<DetachedResult> {
  return platform === 'win32' ? spawnOrphan(spec) : spawnInNewSession(spec);
}
