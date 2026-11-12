/**
 * Minimal reader for `~/.rooks/rooks.config.json` (plan §5.1).
 *
 * This is a deliberate COPY of the orchestrator loader, not an import: the two
 * packages are independent (the desktop client ships without the orchestrator
 * sources on disk at type-check time, and Electron must not pull `zod` in).
 * Only the keys the shell actually needs are read — where to reach the daemon,
 * where the UI is served, how the daemon is supervised, how big its heap is.
 * Everything else is the daemon's business; the shell holds no product logic.
 *
 * Unknown or malformed values fall back to the schema defaults instead of
 * throwing: a broken config file must still let the user open the window and
 * fix it. The daemon, which is the authority on that file, refuses to start on
 * an invalid config and says why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Listen = { host: string; port: number };
export type Supervisor = 'systemd-user' | 'launchd' | 'windows' | 'none';

export type DesktopConfig = {
  /** Where all Rooks state lives — `ROOKS_HOME` wins over `~/.rooks`. */
  home: string;
  daemon: { listen: Listen; supervisor: Supervisor; heapMb: number; installDir: string };
  app: { enabled: boolean; listen: Listen };
  /**
   * No `rooks.config.json` and we are a package: the values below are ours,
   * not the daemon's (see `PACKAGED_DEFAULTS`). The shell must then TELL the
   * daemon what it decided, or the two would disagree on where the UI is.
   */
  packagedDefaults: boolean;
};

/**
 * Same defaults as `orchestrator/src/config/schema.ts`, with one exception:
 * the daemon now derives `installDir` from where its own code sits, which this
 * process cannot compute for it. The value below is a last-resort mirror that
 * nothing reads — `main.ts` passes `daemonInstallDirOf(process.resourcesPath)`
 * to the embedded daemon, and a service reads its own. Keep the rest in sync.
 */
const DEFAULTS = {
  daemon: {
    listen: { host: '127.0.0.1', port: 3000 },
    supervisor: 'systemd-user' as Supervisor,
    heapMb: 4096,
    installDir: '~/rooks/orchestrator',
  },
  app: { enabled: false, listen: { host: '127.0.0.1', port: 3100 } },
};

/**
 * What an installed package does when it finds no configuration file.
 *
 * The daemon's own defaults describe a DEVELOPER machine (a service under
 * systemd, the UI served by Compose, port 3000) and must stay that way — the
 * project's rule is "no config file = current behaviour". Applied to a fresh
 * installation they are hostile in three distinct ways, all silent:
 *
 * - `supervisor: systemd-user` waits for a service nobody installed, so the
 *   package never enters portable mode and never starts anything;
 * - `app.enabled: false` serves no UI at all, since there is no Compose here;
 * - ports 3000/3100 are crowded. Anything answering there with a `GET
 *   /api/health` is read as "Rooks is up": the shell then opens a window on an
 *   app port nobody serves, and shows a blank page with no message.
 *
 * Hence the ports below, which sit clear of both the conventional 3000/3100
 * and of a source checkout's 3001/3101. **They are part of what was shipped to
 * testers — changing them orphans every existing installation.**
 */
export const PACKAGED_DEFAULTS = {
  daemon: {
    listen: { host: '127.0.0.1', port: 3010 } as Listen,
    supervisor: 'none' as Supervisor,
  },
  app: { enabled: true, listen: { host: '127.0.0.1', port: 3110 } as Listen },
};

// `windows` is the logon scheduled task (step 5.7.2). Like the other two
// named supervisors it means "someone else keeps the daemon alive", so the
// shell expects a daemon instead of running one.
const SUPERVISORS: readonly Supervisor[] = ['systemd-user', 'launchd', 'windows', 'none'];

/** Replaces a leading `~` with the user home. */
export function expandTilde(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** `ROOKS_HOME` if set and non-empty, else `~/.rooks`. */
export function resolveNovaHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.ROOKS_HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.rooks');
}

export function configFile(home: string): string {
  return join(home, 'rooks.config.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readListen(raw: unknown, fallback: Listen): Listen {
  if (!isPlainObject(raw)) return fallback;
  const host = typeof raw['host'] === 'string' && raw['host'] ? raw['host'] : fallback.host;
  const port = typeof raw['port'] === 'number' && Number.isInteger(raw['port']) && raw['port'] > 0
    ? raw['port']
    : fallback.port;
  return { host, port };
}

/**
 * Reads the config file of `home`; a missing or unreadable file gives defaults.
 *
 * `packaged` comes from `app.isPackaged` — passed in rather than imported, so
 * this module stays testable under plain `node --test` without Electron. It
 * only matters when the file is ABSENT: a malformed file still degrades to the
 * daemon's defaults, because someone wrote it and their intent is not ours to
 * guess.
 */
/**
 * A packaged install that has no `rooks.config.json` yet: the onboarding comes
 * next. Readable before the configuration is loaded, so the very first
 * window (the release check) already takes the onboarding's look.
 */
export function packagedFirstRun(home: string, packaged: boolean): boolean {
  return packaged && !existsSync(configFile(home));
}

export function loadDesktopConfig(
  home: string = resolveNovaHome(),
  opts: { packaged?: boolean } = {},
): DesktopConfig {
  let raw: Record<string, unknown> = {};
  const file = configFile(home);
  const packagedDefaults = packagedFirstRun(home, Boolean(opts.packaged));
  const base = packagedDefaults
    ? { ...DEFAULTS, daemon: { ...DEFAULTS.daemon, ...PACKAGED_DEFAULTS.daemon }, app: PACKAGED_DEFAULTS.app }
    : DEFAULTS;
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isPlainObject(parsed)) raw = parsed;
    } catch {
      // Deliberately silent: see the header. The daemon reports the real error.
    }
  }

  if (packagedDefaults) {
    try {
      const ports = JSON.parse(readFileSync(join(home, 'desktop-bootstrap.json'), 'utf8')) as { daemonPort?: number; appPort?: number };
      const valid = (port: unknown): port is number => Number.isInteger(port) && Number(port) > 1024 && Number(port) < 65536;
      if (valid(ports.daemonPort) && valid(ports.appPort) && ports.daemonPort !== ports.appPort) {
        raw = { daemon: { listen: { host: '127.0.0.1', port: ports.daemonPort } },
          app: { listen: { host: '127.0.0.1', port: ports.appPort } } };
      }
    } catch { /* No previous desktop bootstrap; use the packaged defaults. */ }
  }

  const daemonRaw = isPlainObject(raw['daemon']) ? raw['daemon'] : {};
  const appRaw = isPlainObject(raw['app']) ? raw['app'] : {};

  const supervisor = SUPERVISORS.find((s) => s === daemonRaw['supervisor'])
    ?? base.daemon.supervisor;
  const heapMb = typeof daemonRaw['heapMb'] === 'number' && daemonRaw['heapMb'] > 0
    ? Math.floor(daemonRaw['heapMb'])
    : base.daemon.heapMb;
  const installDir = typeof daemonRaw['installDir'] === 'string' && daemonRaw['installDir']
    ? expandTilde(daemonRaw['installDir'])
    : expandTilde(base.daemon.installDir);

  return {
    home,
    daemon: {
      listen: readListen(daemonRaw['listen'], base.daemon.listen),
      supervisor,
      heapMb,
      installDir,
    },
    app: {
      enabled: typeof appRaw['enabled'] === 'boolean' ? appRaw['enabled'] : base.app.enabled,
      listen: readListen(appRaw['listen'], base.app.listen),
    },
    packagedDefaults,
  };
}

/**
 * What the shell must tell the embedded daemon so both agree.
 *
 * Empty as soon as a `rooks.config.json` exists: that file is the daemon's
 * business, and mirroring it into the environment would only create a second
 * place where the same values can drift. It is when the file is ABSENT that
 * the two processes would otherwise part ways — the shell on the packaged
 * defaults, the daemon on the developer ones.
 *
 * Read by `orchestrator/src/config/load.ts` (`ENV_OVERRIDES`).
 */
export function daemonEnvOverrides(cfg: DesktopConfig): Record<string, string> {
  if (!cfg.packagedDefaults) return {};
  return {
    PORT: String(cfg.daemon.listen.port),
    ROOKS_APP_ENABLED: cfg.app.enabled ? '1' : '0',
    ROOKS_APP_PORT: String(cfg.app.listen.port),
  };
}

/** `http://host:port` — a bare `0.0.0.0` is dialled back to the loopback. */
export function originOf(listen: Listen): string {
  const host = listen.host === '0.0.0.0' || listen.host === '::' ? '127.0.0.1' : listen.host;
  return `http://${host}:${listen.port}`;
}
