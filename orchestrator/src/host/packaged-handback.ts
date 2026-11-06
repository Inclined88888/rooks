/**
 * Gives the Linux service back to an older desktop package reinstalled over
 * this one.
 *
 * The service runs from a copy under `desktop-runtime/releases/`, so
 * reinstalling an older package leaves it on this release. Desktops from
 * 0.1.1 on move it themselves at launch (`desktop/src/upgrade.ts`, any
 * different version). 0.1.0 does not on Linux, and cannot be changed: its
 * window would keep opening on this daemon, this UI and these migrations. So
 * the daemon watches the package it was copied from and, when an installed
 * package too old to migrate the service appears there, runs the same
 * upgrade runner for it: stage, rewrite, probe, roll back on failure.
 *
 * Only a fixed installation directory can be watched (.deb, .rpm). An
 * AppImage runs from a mount that disappears with it, so there is nothing to
 * read: `public-docs` gives the manual procedure.
 *
 * Newer packages are left to their own desktop, which also shows its failure
 * dialog; both acting at once would rewrite the unit twice.
 */
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isBundledNode } from './bundled-node.js';
import { compareVersions } from '../data-version.js';
import { instanceId, runtimeDir } from './packaged-service.js';

/** First desktop version that moves the Linux service itself at launch. */
export const FIRST_SELF_MIGRATING_LINUX = '0.1.1';
const POLL_MS = 15_000;

export type ReleaseSource = { root: string; executable: string };
export type HandbackPlan = { version: string; root: string; executable: string; installDir: string; attempt: string };

export const releaseSourceFile = (home: string): string => join(runtimeDir(home), 'release-source.json');
const attemptFile = (home: string): string => join(runtimeDir(home), 'handback-attempt');

/**
 * Where the running release was copied from, same rule as
 * `stagePackagedRuntime`. Written once the service runs that copy.
 */
export function recordReleaseSource(home: string, executable: string): void {
  // The Node the package ships sits in `<root>/resources/node/`; Electron at the root.
  const bundled = isBundledNode(executable, process.platform);
  const source: ReleaseSource = bundled
    ? { root: realpathSync(dirname(dirname(dirname(executable)))), executable: join('resources', 'node', basename(executable)) }
    : { root: realpathSync(dirname(executable)), executable: basename(executable) };
  writeFileSync(releaseSourceFile(home), `${JSON.stringify(source)}\n`, { mode: 0o600 });
}

export function readReleaseSource(home: string): ReleaseSource | null {
  try {
    const parsed = JSON.parse(readFileSync(releaseSourceFile(home), 'utf8')) as Partial<ReleaseSource>;
    return typeof parsed.root === 'string' && typeof parsed.executable === 'string'
      ? { root: parsed.root, executable: parsed.executable }
      : null;
  } catch {
    return null;
  }
}

export type InstalledPackage = { version: string; changedAt: number; complete: boolean };

/** Version of the package now installed at `source`, read from the file the build writes. */
export function inspectInstalledPackage(source: ReleaseSource): InstalledPackage | null {
  const installDir = join(source.root, 'resources', 'orchestrator');
  const manifest = join(installDir, 'package.json');
  try {
    const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
    if (typeof version !== 'string') return null;
    return {
      version,
      changedAt: statSync(manifest).mtimeMs,
      complete: existsSync(join(source.root, source.executable))
        && existsSync(join(installDir, 'dist', 'host', 'packaged-runner.js')),
    };
  } catch {
    return null; // Removed, or an AppImage mount that is gone.
  }
}

export function handbackPlan(input: {
  platform: NodeJS.Platform;
  ownVersion: string;
  source: ReleaseSource | null;
  installed: InstalledPackage | null;
  attempted: string | null;
}): HandbackPlan | null {
  const { source, installed } = input;
  if (input.platform !== 'linux' || !source || !installed?.complete) return null;
  if (installed.version === input.ownVersion) return null;
  if ((compareVersions(installed.version, FIRST_SELF_MIGRATING_LINUX) ?? 0) >= 0) return null;
  // One attempt per installation: a reinstall rewrites the manifest.
  const attempt = `${installed.version}@${installed.changedAt}`;
  if (attempt === input.attempted) return null;
  return {
    version: installed.version,
    root: source.root,
    executable: join(source.root, source.executable),
    installDir: join(source.root, 'resources', 'orchestrator'),
    attempt,
  };
}

/**
 * The runner restarts this very service, whose control group systemd kills:
 * it must live in its own transient unit to probe the result and roll back.
 */
export function handbackCommand(plan: HandbackPlan, ctx: {
  home: string;
  ownExecutable: string;
  ownInstallDir: string;
  env: NodeJS.ProcessEnv;
  now: number;
}): { command: string; args: string[] } {
  const env: Record<string, string> = {
    // Only Electron needs it; the Node the package ships would pass it on.
    ...(isBundledNode(ctx.ownExecutable, 'linux') ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    TIMON_HOME: ctx.home,
    TIMON_DESKTOP_EMBEDDED: '1',
    TIMON_DESKTOP_SERVICE: '0',
    TIMON_DESKTOP_UPGRADE: '1',
    TIMON_DESKTOP_VERSION: plan.version,
    TIMON_INSTALL_DIR: plan.installDir,
    TIMON_RELEASE_EXECUTABLE: plan.executable,
  };
  for (const key of ['PORT', 'TIMON_APP_ENABLED', 'TIMON_APP_PORT', 'PATH'] as const) {
    const value = ctx.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    command: 'systemd-run',
    args: [
      '--user', '--collect', '--quiet',
      `--unit=timon-handback-${instanceId(ctx.home)}-${ctx.now}`,
      ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
      ctx.ownExecutable,
      join(ctx.ownInstallDir, 'dist', 'host', 'packaged-upgrade-runner.js'),
    ],
  };
}

export type HandbackDeps = {
  platform: NodeJS.Platform;
  home: string;
  ownVersion: string;
  ownExecutable: string;
  ownInstallDir: string;
  env: NodeJS.ProcessEnv;
  inspect: (source: ReleaseSource) => InstalledPackage | null;
  run: (command: string, args: string[]) => { code: number; stderr: string };
  log: (message: string) => void;
  now: () => number;
};

/**
 * One poll. A version must be seen twice in a row before acting: dpkg writes
 * the tree file by file, and the manifest may land before the executable.
 */
export function createHandbackPoller(deps: HandbackDeps): () => 'idle' | 'waiting' | 'started' | 'failed' {
  let pending: string | null = null;
  let done = false;
  return () => {
    if (done) return 'idle';
    const source = readReleaseSource(deps.home);
    let attempted: string | null = null;
    try { attempted = readFileSync(attemptFile(deps.home), 'utf8').trim() || null; } catch { /* never attempted */ }
    const plan = handbackPlan({
      platform: deps.platform, ownVersion: deps.ownVersion, source,
      installed: source ? deps.inspect(source) : null, attempted,
    });
    if (!plan) { pending = null; return 'idle'; }
    if (pending !== plan.attempt) { pending = plan.attempt; return 'waiting'; }
    // Recorded first: a runner that fails and restores this unit restarts
    // this daemon, which must not try the same installation again forever.
    writeFileSync(attemptFile(deps.home), `${plan.attempt}\n`, { mode: 0o600 });
    const { command, args } = handbackCommand(plan, { ...deps, now: deps.now() });
    const result = deps.run(command, args);
    done = true;
    if (result.code !== 0) {
      deps.log(`[desktop-runtime] could not hand the service back to Timon ${plan.version}: ${result.stderr.trim() || result.code}`);
      return 'failed';
    }
    deps.log(`[desktop-runtime] Timon ${plan.version} was reinstalled: handing the service back to it`);
    return 'started';
  };
}

export function startReleaseHandback(deps: HandbackDeps, everyMs = POLL_MS): () => void {
  const poll = createHandbackPoller(deps);
  const tick = () => {
    try {
      if (poll() === 'started') clearInterval(timer);
    } catch (error) {
      deps.log(`[desktop-runtime] release handback check failed: ${(error as Error).message}`);
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
