/**
 * What `rooks app status|restart` needs to know about the Next app served
 * by the daemon (step 3.7).
 *
 * A file separate from `index.ts` — and that is the important point: the CLI loads it
 * from `dist/` in a process that is NOT the daemon. `index.ts` pulls in
 * Cordis, `child-supervisor` and so `notifications` → the database: opening the database
 * to answer "is the app running?" would be absurd, and would set a
 * second SQLite reader where there is nothing to read.
 *
 * Neither of these two commands touches systemd. Restarting the orchestrator
 * to relaunch the app would kill every living mission; we signal the
 * child, and its supervisor picks it back up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../../config/load.js';
import type { NovaConfig } from '../../config/schema.js';
import { childPidFile } from '../../paths.js';

/** Label of the child, as the supervisor names it in its logs and its pidfile.
 *  Deliberately distinct from `MODULE_ID`: the id now carries a `/`, which
 *  would make `childPidFile()` a path in a non-existent subfolder. */
export const LABEL = 'web-app';

/** Id of the module in `config.modules` (§10.14). */
export const MODULE_ID = '@rooks/web-app';

export const APP_PID_FILE = childPidFile(LABEL);

/** Next in production (`NODE_ENV=production`) refuses to boot without this
 *  file. An incomplete `next build` still writes `.next/` and `BUILD_ID`, so
 *  "the directory exists" is not "the app will start". */
export const APP_BUILD_MARKER = 'prerender-manifest.json';

export function appIsBuilt(appDir: string): boolean {
  return existsSync(join(appDir, '.next', APP_BUILD_MARKER));
}

export type AppState = 'disabled' | 'not-built' | 'running' | 'stopped';

export type AppStatus = {
  state: AppState;
  /** One sentence, actionable when there is an action. */
  message: string;
  /** Pid of the living child, otherwise `null`. */
  pid: number | null;
  /** Where the app is expected on disk, so that the message can be checked. */
  appDir: string;
  listen: { host: string; port: number };
};

/**
 * Location of the app, relative to the daemon's installation folder
 * (`<installDir>/../app`), as `orchestrator-self` already does.
 *
 * Lives here rather than in `index.ts` (from which it is re-exported, for `telegram`)
 * because the CLI needs it without loading Cordis.
 */
export function appDirOf(cfg: NovaConfig): string {
  return resolve(cfg.daemon.installDir, '..', 'app');
}

/**
 * Is the pid that of a living process? Signal `0` only tests.
 * `EPERM` = the process exists but belongs to someone else: alive.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Pid published by the supervisor, `null` if the file is missing, unreadable,
 *  not numeric or stale (dead process). */
export function readAppPid(file: string = APP_PID_FILE): number | null {
  if (!existsSync(file)) return null;
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pidAlive(pid) ? pid : null;
}

/**
 * `rooks app status`. Never throws: a missing daemon, a missing config or
 * an app never built are all normal states to display, not
 * errors. The order of the cases is that of the diagnosis — no point talking about build
 * when the module will not run anyway.
 */
export function appStatus(cfg: NovaConfig = config(), file: string = APP_PID_FILE): AppStatus {
  const appDir = appDirOf(cfg);
  const listen = { host: cfg.app.listen.host, port: cfg.app.listen.port };
  const base = { pid: null, appDir, listen };

  // Two independent switches: the `modules` table switches the whole module
  // off (like any other), `app.enabled` switches off the launch of
  // the app. The first wins, it is the one `rooks module disable` writes.
  const moduleSetting = cfg.modules[MODULE_ID];
  const moduleOff = moduleSetting === false
    || (typeof moduleSetting === 'object' && moduleSetting !== null && moduleSetting.enabled === false);
  if (moduleOff) {
    return { ...base, state: 'disabled', message: `module ${MODULE_ID} disabled in rooks.config.json (rooks module enable ${MODULE_ID})` };
  }
  if (!cfg.app.enabled) {
    return { ...base, state: 'disabled', message: "app.enabled = false — the app stays served by docker compose --profile docker (see docs/REBUILD.md)" };
  }

  const built = join(appDir, '.next', APP_BUILD_MARKER);
  if (!appIsBuilt(appDir)) {
    return { ...base, state: 'not-built', message: `app not built: cd app && npm run build (expected: ${built})` };
  }

  const pid = readAppPid(file);
  if (pid !== null) {
    return { ...base, pid, state: 'running', message: `web-app child alive (pid ${pid}) on ${listen.host}:${listen.port}` };
  }
  return {
    ...base,
    state: 'stopped',
    message: "no live web-app child — the daemon did not start it (config changed since it started?) or it is restarting",
  };
}

export type RestartResult = { ok: boolean; pid: number | null; message: string };

/**
 * `rooks app restart` — signals the child, the supervisor relaunches it after its
 * backoff (2 s the first time).
 *
 * We do not relaunch it ourselves: the child belongs to the daemon, which
 * watches it. Spawning it from the CLI would set a second Next on the same port,
 * orphaned and invisible to the supervisor.
 *
 * Careful, anti-loop guard: five consecutive quick falls (the child
 * did not hold a minute) exhaust the supervisor's counter, which then gives up
 * and alerts. A port still held does not count: the supervisor waits
 * for it to free up, without limit. In real use a `next build` takes much more
 * than a minute — but it is better known than discovered.
 */
export function restartApp(cfg: NovaConfig = config(), file: string = APP_PID_FILE): RestartResult {
  const status = appStatus(cfg, file);
  if (status.state !== 'running' || status.pid === null) {
    return { ok: false, pid: null, message: status.message };
  }
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, pid: status.pid, message: `signal refused (pid ${status.pid}): ${(err as Error).message}` };
  }
  return {
    ok: true,
    pid: status.pid,
    message: `web-app child (pid ${status.pid}) signalled — the daemon restarts it in 2 s`,
  };
}
