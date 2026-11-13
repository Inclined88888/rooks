/**
 * `rooks update apply`: moves an installed packaged service onto the package
 * this CLI belongs to, from a terminal, without opening the app.
 *
 * On macOS and Linux the service runs from a copy under
 * `desktop-runtime/releases/`, so installing a new .deb or .pkg leaves the
 * previous daemon running; until now only the desktop moved it, at launch
 * (`desktop/src/upgrade.ts`). A tester who updates a headless machine saw
 * `rooks update status` report the old version and nothing else.
 *
 * Nothing is reimplemented here: the CLI runs the desktop's own upgrade
 * runner (`packaged-upgrade-runner.ts` → `upgradeDesktopService`) with the
 * environment the desktop gives it — stage, rewrite, restart, health probe,
 * roll back on failure. What is specific to a terminal is how the runner is
 * launched: it restarts the service, and must survive it even when the CLI
 * itself is a child of that service (a mission, the app's terminal).
 * No database import: the CLI loads this before any approval.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isBundledNode } from './bundled-node.js';
import { compareVersions } from '../data-version.js';
import { instanceId, packagedReleaseId, runtimeDir } from './packaged-service.js';

export const APPLY_COMMAND = 'rooks update apply';

/** Platforms whose service runs from a staged copy, as `stagesPackagedRuntime` says. */
const STAGED = new Set<NodeJS.Platform>(['linux', 'darwin']);

export type ServiceLag = { version: string; serviceOutdated: true; command: string };

/**
 * The installed package is newer than the daemon that answers. Only a
 * packaged CLI knows a package version; Windows has no copy left behind (the
 * installer stops the daemon before replacing its files).
 */
export function serviceLag(input: {
  platform: NodeJS.Platform;
  packaged: boolean;
  cliVersion: string;
  daemonVersion: unknown;
}): ServiceLag | null {
  if (!input.packaged || !STAGED.has(input.platform) || typeof input.daemonVersion !== 'string') return null;
  if ((compareVersions(input.cliVersion, input.daemonVersion) ?? 0) <= 0) return null;
  return { version: input.cliVersion, serviceOutdated: true, command: APPLY_COMMAND };
}

export function serviceLagMessage(lag: ServiceLag, daemonVersion: string): string {
  return `Rooks ${lag.version} is installed, but the background service still runs ${daemonVersion}. `
    + `Run \`${lag.command}\` to move the service to ${lag.version}, then \`rooks update approve ${lag.version}\` if it asks for approval.`;
}

export type ApplyFacts = {
  platform: NodeJS.Platform;
  packaged: boolean;
  cliVersion: string;
  /** What `/api/update/status` reports; `null` when no daemon answers. */
  daemonVersion: string | null;
  activeRelease: string | null;
  /** A supervisor definition exists for this data directory. */
  serviceInstalled: boolean;
  /** `rooks service install` reinstalls an older package on purpose. */
  allowOlder?: boolean;
};

export type ApplyDecision = { run: true } | { run: false; code: number; message: string };

export function applyDecision(f: ApplyFacts): ApplyDecision {
  if (f.platform === 'win32') {
    return { run: false, code: 0, message: 'On Windows the service runs from the installation folder: the installer already moved it. '
      + 'Start it with `rooks service start` or by opening Rooks.' };
  }
  if (!STAGED.has(f.platform)) return { run: false, code: 1, message: `There is no packaged service to update on ${f.platform}.` };
  if (!f.packaged) {
    return { run: false, code: 1, message: 'Run this with the `rooks` command of the installed Rooks package: '
      + 'a CLI run from the sources has no release to move the service to.' };
  }
  if (!f.serviceInstalled) {
    return { run: false, code: 1, message: 'No background service is installed for this data directory: '
      + 'install it with `rooks service install`, or open Rooks.' };
  }
  if (f.daemonVersion !== null && !f.allowOlder && (compareVersions(f.daemonVersion, f.cliVersion) ?? 0) > 0) {
    return { run: false, code: 1, message: `The service runs Rooks ${f.daemonVersion}, newer than this package (${f.cliVersion}). `
      + 'Reinstall the newer package, or open this Rooks to move the service back to it.' };
  }
  if (f.daemonVersion === f.cliVersion && f.activeRelease === packagedReleaseId(f.cliVersion)) {
    return { run: false, code: 0, message: `The service already runs Rooks ${f.cliVersion}.` };
  }
  return { run: true };
}

export type RunnerInput = {
  platform: NodeJS.Platform;
  home: string;
  cliVersion: string;
  /** The package's runtime the CLI runs on: the Node it ships, or Electron as Node. */
  execPath: string;
  /** The orchestrator of this package (`config.daemon.installDir`). */
  installDir: string;
  daemonPort: number;
  appEnabled: boolean;
  appPort: number;
  path: string | undefined;
  now: number;
};

export type RunnerLaunch = { command: string; args: string[]; env: NodeJS.ProcessEnv; logFile: string; detached: boolean };

/** Where the runner writes what it did: a pipe back to the CLI would break when a restart kills it. */
export function applyLogFile(home: string): string {
  return join(runtimeDir(home), 'update-apply.log');
}

/** Same variables as `upgradePackagedService` (desktop) and `handbackCommand`. */
export function runnerEnvironment(input: RunnerInput): Record<string, string> {
  return {
    // Only Electron needs it; the Node the package ships would pass it on.
    ...(isBundledNode(input.execPath, input.platform) ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    ROOKS_HOME: input.home,
    ROOKS_DESKTOP_EMBEDDED: '1',
    ROOKS_DESKTOP_SERVICE: '0',
    ROOKS_DESKTOP_UPGRADE: '1',
    ROOKS_DESKTOP_VERSION: input.cliVersion,
    ROOKS_INSTALL_DIR: input.installDir,
    ROOKS_APP_ENABLED: input.appEnabled ? '1' : '0',
    ROOKS_APP_PORT: String(input.appPort),
    PORT: String(input.daemonPort),
    ...(input.path ? { PATH: input.path } : {}),
  };
}

/**
 * Linux: `KillMode=control-group` empties the service's cgroup on restart,
 * and a CLI started by a mission lives there: the runner gets a transient
 * unit of its own, as the handback does, and `--wait` keeps the CLI waiting
 * on it. macOS: launchd kills the job's process group; a new session is
 * out of its reach (`detached.ts`).
 */
export function runnerLaunch(input: RunnerInput): RunnerLaunch {
  const runner = join(input.installDir, 'dist', 'host', 'packaged-upgrade-runner.js');
  const env = runnerEnvironment(input);
  const logFile = applyLogFile(input.home);
  if (input.platform === 'linux') {
    return {
      command: 'systemd-run',
      args: [
        '--user', '--wait', '--collect', '--quiet',
        `--unit=rooks-update-${instanceId(input.home)}-${input.now}`,
        `--property=StandardOutput=append:${logFile}`,
        `--property=StandardError=append:${logFile}`,
        ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
        input.execPath,
        runner,
      ],
      env: process.env,
      logFile,
      detached: false,
    };
  }
  return { command: input.execPath, args: [runner], env: { ...process.env, ...env }, logFile, detached: true };
}

export type RunnerOutcome = { code: number; output: string };

/** Waits for the runner, however long the new daemon takes to boot: killing it mid-way would skip the rollback. */
export function runUpgradeRunner(launch: RunnerLaunch): Promise<RunnerOutcome> {
  mkdirSync(dirname(launch.logFile), { recursive: true });
  writeFileSync(launch.logFile, '', { mode: 0o600 });
  const read = () => { try { return readFileSync(launch.logFile, 'utf8'); } catch { return ''; } };
  return new Promise((resolve) => {
    let fd: number | null = null;
    // What `systemd-run` itself says when it refuses (an old systemd, no user bus).
    let launcherError = '';
    const finish = (code: number, extra = '') => {
      if (fd !== null) closeSync(fd);
      fd = null;
      resolve({ code, output: `${read()}${launcherError}${extra}` });
    };
    try {
      fd = launch.detached ? openSync(launch.logFile, 'a') : null;
      const child = spawn(launch.command, launch.args, {
        env: launch.env,
        detached: launch.detached,
        stdio: fd === null ? ['ignore', 'ignore', 'pipe'] : ['ignore', fd, fd],
      });
      child.stderr?.on('data', (chunk: Buffer) => { launcherError += chunk.toString(); });
      child.once('error', (error) => finish(127, `${error.message}\n`));
      child.once('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
    } catch (error) {
      finish(127, `${(error as Error).message}\n`);
    }
  });
}

/** `[desktop-runtime]` warnings and Node's stack noise stay in the log file; the reader gets the verdict. */
function meaningfulLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line && !/^\s+at\s/.test(line));
}

export type ApplyResult = { code: number; lines: string[] };

export async function applyServiceUpdate(
  facts: ApplyFacts,
  input: RunnerInput,
  run: (launch: RunnerLaunch) => Promise<RunnerOutcome> = runUpgradeRunner,
): Promise<ApplyResult> {
  const decision = applyDecision(facts);
  if (!decision.run) return { code: decision.code, lines: [decision.message] };
  const launch = runnerLaunch(input);
  const outcome = await run(launch);
  const lines = meaningfulLines(outcome.output);
  if (outcome.code !== 0) {
    return { code: 1, lines: [
      ...lines,
      `The service could not be moved to Rooks ${input.cliVersion}; your data in ${input.home} were not modified.`,
      `Details: ${launch.logFile}`,
    ] };
  }
  return { code: 0, lines: [
    ...lines,
    `The service now runs Rooks ${input.cliVersion}.`,
    `Next: \`rooks update status\`; if it shows "pending", approve with \`rooks update approve ${input.cliVersion}\`.`,
  ] };
}
