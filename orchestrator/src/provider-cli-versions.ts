/**
 * Which version of each AI CLI this machine runs, and whether its vendor has
 * published a newer one — for "Update available" on the provider cards.
 *
 * Never on the path of a request: the cards read what the last check left here,
 * and the check runs in the background, at boot and then every
 * `ROOKS_CLI_UPDATE_INTERVAL_HOURS` (one hour at the least). Off with
 * `ROOKS_CLI_UPDATE_CHECK`, which stops every request to the vendors; the
 * installed version is a local `--version` and stays shown.
 *
 * The installed version is read from the binary the DAEMON resolves, and kept
 * with its path: when two copies are installed (npm and standalone), the one
 * missions run is the one that has to be up to date, and a re-install that
 * lands in the other one must not look like a fix.
 */
import { BUILTIN_DECLARATIONS, type CliLatestSource } from './backends/builtin-declarations.js';
import { config } from './config/load.js';
import { whichBin } from './doctor.js';
import { getHost } from './host/index.js';
import { settingBool, settingInt } from './settings.js';

const VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/;
const VERSION_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
/** First check once the daemon has settled: boot has better things to do with the network. */
const FIRST_CHECK_DELAY_MS = 30_000;

/** `2.1.310 (Claude Code)`, `codex-cli 0.159.0`, `grok 1.0.13 (5e9a585) [stable]` → the version. */
export function parseCliVersion(output: string): string | null {
  return VERSION.exec(output)?.[1] ?? null;
}

/** Semver order, enough for release versions: numbers first, a prerelease below its release. */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = a.split('-', 2);
  const [coreB = '', preB] = b.split('-', 2);
  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

/** The registry's `latest` document of a package, scope included (`@scope%2Fname`). */
export function npmLatestUrl(pkg: string): string {
  return `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`;
}

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The newest published version, or `null` with the reason logged: a check that fails says nothing on the card. */
export async function fetchLatestVersion(source: CliLatestSource, fetchImpl: Fetch = fetch): Promise<string | null> {
  const url = 'npm' in source ? npmLatestUrl(source.npm) : source.text;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'npm' in source ? 'application/json' : 'text/plain' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if ('npm' in source) {
      const version = (JSON.parse(body) as { version?: unknown }).version;
      return typeof version === 'string' && parseCliVersion(version) === version ? version : null;
    }
    // The whole body is the version; anything else (a page, an error) is not one.
    const trimmed = body.trim();
    return parseCliVersion(trimmed) === trimmed ? trimmed : null;
  } catch (error) {
    console.warn(`[provider-cli] latest version from ${url}: ${(error as Error).message}`);
    return null;
  }
}

/** The CLIs whose versions are checked: the product's providers that said where their releases are. */
export function versionCheckedClis(): Array<{ name: string; latest: CliLatestSource; supportedMajor?: number }> {
  return Object.values(BUILTIN_DECLARATIONS).flatMap((declared) => (declared.binary && declared.updateCheck
    ? [{
      name: declared.binary.names[0]!,
      latest: declared.updateCheck.latest,
      ...(declared.updateCheck.supportedMajor === undefined ? {} : { supportedMajor: declared.updateCheck.supportedMajor }),
    }]
    : []));
}

/** `version` belongs to a major the provider does not support (`updateCheck.supportedMajor`). */
export function beyondSupportedMajor(version: string | null, supportedMajor: number | undefined): boolean {
  if (version === null || supportedMajor === undefined) return false;
  const major = Number(version.split('.', 1)[0]);
  return Number.isFinite(major) && major > supportedMajor;
}

export type CliVersionInfo = {
  /** Installed version of the binary at `path`, `null` when it could not be read. */
  version: string | null;
  /** Newest published version, `null` when unknown or the check is off. */
  latest: string | null;
  updateAvailable: boolean;
  /**
   * The installed binary is a generation the provider does not support: its installer would put
   * the supported one in its place, so the card offers neither Install nor Update.
   */
  unsupportedVersion: boolean;
};

const installed = new Map<string, { path: string; version: string | null }>();
const published = new Map<string, string>();
let lastCheckAt = 0;
let running: Promise<void> | null = null;

/**
 * `--version` of the binary at `path`, the one `locate` resolved. Never the bare
 * name: a pin or a copy outside the service's PATH would answer for another
 * binary than the one the card shows. The host runs an absolute path as is, and
 * wraps a Windows `.cmd` shim in `cmd.exe` like any other launch.
 */
async function readInstalledVersion(path: string): Promise<string | null> {
  try {
    const res = await getHost().execAsync(path, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true });
    return res.code === 0 ? parseCliVersion(`${res.stdout}\n${res.stderr}`) : null;
  } catch {
    return null;
  }
}

export type VersionDeps = {
  locate?: (name: string) => string | null;
  /** Reads the version of the binary at this exact path. */
  readVersion?: (path: string) => Promise<string | null>;
  latest?: (source: CliLatestSource) => Promise<string | null>;
  /** `ROOKS_CLI_UPDATE_CHECK`: off, the vendors are not asked. */
  enabled?: () => boolean;
};

/**
 * Reads the installed versions again, and the published ones when the check is
 * on. `names` narrows it to the CLIs just installed. Concurrent calls share one run.
 */
export function refreshCliVersions(names?: readonly string[], deps: VersionDeps = {}): Promise<void> {
  if (running && !names) return running;
  const locate = deps.locate ?? ((name: string) => whichBin(name, config().host.binaries).path);
  const readVersion = deps.readVersion ?? readInstalledVersion;
  const latest = deps.latest ?? ((source: CliLatestSource) => fetchLatestVersion(source));
  const enabled = deps.enabled ?? (() => settingBool('ROOKS_CLI_UPDATE_CHECK'));
  const targets = versionCheckedClis().filter((cli) => !names || names.includes(cli.name));
  const run = (async () => {
    const online = enabled();
    await Promise.all(targets.map(async (cli) => {
      const path = locate(cli.name);
      if (!path) { installed.delete(cli.name); return; }
      installed.set(cli.name, { path, version: await readVersion(path) });
      if (!online) return;
      const version = await latest(cli.latest);
      if (version) published.set(cli.name, version);
    }));
    if (!online) published.clear();
    if (!names) lastCheckAt = Date.now();
  })();
  if (!names) running = run.finally(() => { running = null; });
  return run;
}

/** What the card of `name` shows: only a version read from the binary at `path` counts. */
export function cliVersionInfo(name: string, path: string | null, enabled: () => boolean = () => settingBool('ROOKS_CLI_UPDATE_CHECK')): CliVersionInfo {
  const local = installed.get(name);
  const version = path && local?.path === path ? local.version : null;
  const latest = enabled() ? published.get(name) ?? null : null;
  const unsupportedVersion = beyondSupportedMajor(version, versionCheckedClis().find((cli) => cli.name === name)?.supportedMajor);
  return {
    version,
    latest,
    updateAvailable: !unsupportedVersion && version !== null && latest !== null && compareVersions(latest, version) > 0,
    unsupportedVersion,
  };
}

/**
 * Whether the binary at `path` is beyond the major `name` supports, read NOW: the install route
 * asks before running an installer that would replace it, and a daemon that has not swept yet
 * has nothing cached. A local `--version`, never a request to the vendor; kept for the cards.
 */
export async function installedBeyondSupportedMajor(name: string, path: string, readVersion: (path: string) => Promise<string | null> = readInstalledVersion): Promise<boolean> {
  const supportedMajor = versionCheckedClis().find((cli) => cli.name === name)?.supportedMajor;
  if (supportedMajor === undefined) return false;
  const version = await readVersion(path);
  installed.set(name, { path, version });
  return beyondSupportedMajor(version, supportedMajor);
}

/** The interval between two checks: at least one hour, whatever the setting says. */
export function updateCheckIntervalMs(hours: number = settingInt('ROOKS_CLI_UPDATE_INTERVAL_HOURS')): number {
  return Math.max(1, Number.isFinite(hours) ? hours : 12) * 3_600_000;
}

/**
 * The background check: once shortly after boot, then on the interval. A tick
 * that comes too early (the interval was shortened, a check ran on demand)
 * waits for the next one. Returns the disposer.
 */
export function startCliVersionSweep(deps: VersionDeps & { firstDelayMs?: number; tickMs?: number } = {}): () => void {
  const tick = (): void => {
    if (Date.now() - lastCheckAt < updateCheckIntervalMs()) return;
    void refreshCliVersions(undefined, deps).catch((error: Error) => console.warn(`[provider-cli] version check: ${error.message}`));
  };
  const first = setTimeout(tick, deps.firstDelayMs ?? FIRST_CHECK_DELAY_MS);
  first.unref?.();
  // A short tick that only looks at the clock: changing the interval applies without a restart.
  const timer = setInterval(tick, deps.tickMs ?? 300_000);
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/** A list read before any check ran starts one, without waiting for it. */
export function ensureCliVersionsChecked(): void {
  if (lastCheckAt === 0 && !running) void refreshCliVersions().catch(() => { /* logged per CLI */ });
}

export function resetCliVersionsForTests(): void {
  installed.clear();
  published.clear();
  lastCheckAt = 0;
  running = null;
}
