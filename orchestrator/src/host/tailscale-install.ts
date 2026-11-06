/**
 * "Install Tailscale": the vendor's own installer, per OS, with nothing to
 * install first (Machines, 25/10/2026 — Homebrew was a prerequisite nobody
 * had, and the user had to find the way alone).
 *
 *  - macOS: the standalone `.pkg` from pkgs.tailscale.com, its sha256 checked
 *    against the file the same server publishes, its signature checked with
 *    `pkgutil` (Developer ID Installer of Tailscale Inc., team `W5364U7YZB`),
 *    then opened in the macOS Installer, which asks for the password itself.
 *  - Windows: the official MSI, same sha256 check, Authenticode signature of
 *    Tailscale Inc. checked by PowerShell, then `msiexec` (UAC).
 *
 * The packaged daemon often has no desktop to open either on: the Windows
 * scheduled task runs in session 0 (S4U), the macOS LaunchDaemon in the
 * `System` domain. There the daemon still downloads and verifies, then hands
 * the verified file to the Timon desktop app, which lives in the user's
 * session and opens it (`desktop/src/tailscale-installer.ts`). Both services
 * run as the user's own account (S4U principal, plist `UserName`), so the
 * 0700 temporary directory stays readable by that app and by nobody else.
 *  - Linux: the official script (`tailscale.com/install.sh`, which adds the
 *    vendor's signed package repository) run through `pkexec`, the desktop's
 *    own password dialog. No pkexec, or no agent to answer it: the command to
 *    paste in a terminal, with sudo.
 *
 * What is never done: a URL from the client (every address is a constant
 * here), a password asked or kept by Timon, a downloaded file left behind.
 * Every refusal is typed and carries the command a person runs instead.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { DesktopSession } from './desktop-session.js';
import type { ExecResult } from './types.js';

export const TAILSCALE_PKGS = 'https://pkgs.tailscale.com/stable';
export const TAILSCALE_INSTALL_SCRIPT = 'https://tailscale.com/install.sh';
export const TAILSCALE_DOWNLOAD_PAGE = 'https://tailscale.com/download';
/** Apple team of Tailscale Inc., the one a genuine `.pkg` is signed by. */
export const TAILSCALE_APPLE_TEAM = 'W5364U7YZB';

/** A redirect may only land on the vendor's own hosts. */
const OFFICIAL_HOSTS: ReadonlySet<string> = new Set(['pkgs.tailscale.com', 'dl.tailscale.com', 'tailscale.com']);
/** The 1.104 MSI weighs 39 MB, the pkg about as much: room to grow, not to fill a disk. */
const PACKAGE_MAX_BYTES = 400 * 1024 * 1024;
const SCRIPT_MAX_BYTES = 1024 * 1024;
const VERIFY_TIMEOUT_MS = 60_000;
/** The installer waits on a person (password, UAC, wizard): generous, but bounded. */
const INSTALLER_TIMEOUT_MS = 30 * 60_000;
/** pkexec's own exit codes (`man pkexec`). */
const PKEXEC_DISMISSED = 126;
const PKEXEC_NOT_AUTHORIZED = 127;
/** msiexec: cancelled by the person (1602), UAC refused (1223); 3010 = installed, reboot pending. */
const MSI_CANCELLED: ReadonlySet<number> = new Set([1602, 1223]);
const MSI_SUCCESS: ReadonlySet<number> = new Set([0, 3010]);

export type TailscaleInstallMethod = 'macos-pkg' | 'windows-msi' | 'linux-script';

export type TailscaleInstallFailure =
  /** The official index, checksum or package could not be fetched. */
  | 'download_failed'
  /** The bytes are not the ones the vendor published. */
  | 'checksum_mismatch'
  /** The package is not signed by Tailscale Inc. — never opened. */
  | 'signature_invalid'
  /** The daemon runs where no window can appear (Windows service session, LaunchDaemon), and no desktop app asked. */
  | 'no_desktop'
  /** No way to ask for administrator rights from here (no pkexec, no polkit agent). */
  | 'elevation_unavailable'
  /** The person closed the password / UAC dialog or the installer. */
  | 'cancelled'
  | 'installer_failed'
  | 'unsupported';

/** A verified package left for the desktop app to open; its directory is the caller's to remove. */
export type TailscaleInstaller = { dir: string; path: string; sha256: string };

export type TailscaleInstallResult =
  /** `installer`: verified, not opened — the daemon has no desktop, the desktop app opens it. */
  | { ok: true; method: TailscaleInstallMethod; installer?: TailscaleInstaller }
  | { ok: false; reason: TailscaleInstallFailure; command: string | null; detail: string | null };

export type TailscaleInstallPhase = 'downloading' | 'verifying' | 'installing';

type FetchResponse = {
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type TailscaleInstallDeps = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  fetcher(url: string): Promise<FetchResponse>;
  /** Runs a binary with an argv, never a shell string. */
  exec(file: string, args: string[], timeoutMs: number): Promise<ExecResult>;
  /** Whether a window the daemon opens can be seen (`host/desktop-session.ts`). */
  desktopSession(): Promise<DesktopSession>;
  /** Absolute path of a helper (`pkexec`), `null` when absent. */
  findBinary(name: string): string | null;
  /** Account the daemon runs as: on Linux, made Tailscale operator in the same elevation. */
  username(): string | null;
  /** Fresh private directory, removed by the caller. */
  makeTempDir(): Promise<string>;
  removeDir(path: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  onPhase?(phase: TailscaleInstallPhase): void;
};

/**
 * What a person runs on this machine when the button cannot: no Homebrew on
 * macOS, the vendor's script run as root on Linux (`sudo` explicit, so the
 * elevation never depends on what the script does inside), winget on Windows
 * (present on every supported Windows 10/11).
 */
export function tailscaleManualInstallCommand(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    // portability: macOS-only display string, run by a person in Terminal
    return `curl -fsSLo "$TMPDIR/Tailscale.pkg" ${TAILSCALE_PKGS}/Tailscale-latest-macos.pkg && sudo installer -pkg "$TMPDIR/Tailscale.pkg" -target /`;
  }
  if (platform === 'win32') {
    return 'winget install -e --source winget --accept-source-agreements --accept-package-agreements --id tailscale.tailscale';
  }
  return `curl -fsSL ${TAILSCALE_INSTALL_SCRIPT} | sudo sh`;
}

/** `tailscale set --operator=<user>`, by hand: what lets Timon publish without sudo afterwards (Linux). */
export function tailscaleManualOperatorCommand(): string {
  return 'sudo tailscale set --operator=$USER';
}

/** POSIX account names (`useradd`), the only ones written into the elevated script. */
const POSIX_USERNAME = /^[a-z_][a-z0-9_-]{0,31}\$?$/;

export function safeOperatorName(name: string | null): string | null {
  return name && POSIX_USERNAME.test(name) ? name : null;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The package the stable index lists for this OS and CPU; `null` when it lists none. */
export function packageFromIndex(index: unknown, platform: NodeJS.Platform, arch: NodeJS.Architecture): string | null {
  const root = (index ?? {}) as { MacZips?: Record<string, unknown>; MSIs?: Record<string, unknown> };
  let name: unknown;
  if (platform === 'darwin') name = root.MacZips?.['universal-package'];
  else if (platform === 'win32') name = root.MSIs?.[arch === 'arm64' ? 'arm64' : arch === 'ia32' ? 'x86' : 'amd64'];
  if (typeof name !== 'string' || !FILE_NAME.test(name)) return null;
  const extension = platform === 'darwin' ? '.pkg' : '.msi';
  return name.endsWith(extension) ? name : null;
}

/** First token of a `.sha256` file, when it is one. */
export function parseSha256File(text: string): string | null {
  const token = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function isOfficialUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && OFFICIAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * `pkgutil --check-signature` says who signed: a Developer ID Installer
 * certificate issued by Apple, leaf of the chain, of Tailscale Inc.'s team.
 */
export function pkgSignedByTailscale(output: string): boolean {
  if (!/Status:\s*signed by a (developer )?certificate issued by Apple/i.test(output)) return false;
  const leaf = /^\s*1\.\s*(.+)$/m.exec(output)?.[1]?.trim() ?? '';
  return leaf === `Developer ID Installer: Tailscale Inc. (${TAILSCALE_APPLE_TEAM})`;
}

/** `Get-AuthenticodeSignature` as JSON: a valid signature whose signer is Tailscale Inc. */
export function msiSignedByTailscale(json: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return false; }
  const row = (parsed ?? {}) as { Status?: unknown; Subject?: unknown };
  if (row.Status !== 'Valid' || typeof row.Subject !== 'string') return false;
  return /(^|,\s*)CN="?Tailscale Inc\."?\s*(,|$)/.test(row.Subject);
}

/** A PowerShell single-quoted literal: only `'` needs doubling. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The PowerShell line that reads the Authenticode signature of `file` as JSON. */
export function authenticodeScript(file: string): string {
  return `Get-AuthenticodeSignature -LiteralPath ${psQuote(file)} | ForEach-Object { [pscustomobject]@{ Status = [string]$_.Status; Subject = [string]$_.SignerCertificate.Subject } } | ConvertTo-Json -Compress`;
}

/** The script pkexec runs as root: the vendor's installer, then this account made operator. */
export function linuxElevatedScript(installScript: string, operator: string | null): string {
  // The path is our own temp directory, but TMPDIR is the environment's word: never let it close the quote.
  if (/['\n]/.test(installScript)) throw new InstallStop('installer_failed', 'the temporary directory path cannot be quoted');
  const lines = ['#!/bin/sh', 'set -e', `/bin/sh '${installScript}'`];
  // Best effort: a node that refuses the operator change is still installed.
  if (operator) lines.push(`tailscale set --operator='${operator}' || true`);
  return `${lines.join('\n')}\n`;
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 200) : null;
}

class InstallStop extends Error {
  constructor(readonly reason: TailscaleInstallFailure, readonly detail: string | null = null) {
    super(reason);
  }
}

async function download(deps: TailscaleInstallDeps, url: string, maxBytes: number): Promise<Uint8Array> {
  let response: FetchResponse;
  try {
    response = await deps.fetcher(url);
  } catch (err) {
    throw new InstallStop('download_failed', firstLine((err as Error).message ?? ''));
  }
  if (!response.ok) throw new InstallStop('download_failed', `HTTP ${response.status} — ${url}`);
  if (response.url && !isOfficialUrl(response.url)) throw new InstallStop('download_failed', `redirected away from Tailscale: ${response.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new InstallStop('download_failed', `${url} is larger than expected`);
  return bytes;
}

async function downloadText(deps: TailscaleInstallDeps, url: string): Promise<string> {
  return new TextDecoder().decode(await download(deps, url, SCRIPT_MAX_BYTES));
}

/** The official package for this machine, its bytes matching the published sha256. */
async function fetchVerifiedPackage(deps: TailscaleInstallDeps): Promise<{ name: string; bytes: Uint8Array; sha256: string }> {
  deps.onPhase?.('downloading');
  let index: unknown;
  try {
    index = JSON.parse(await downloadText(deps, `${TAILSCALE_PKGS}/?mode=json`)) as unknown;
  } catch (err) {
    if (err instanceof InstallStop) throw err;
    throw new InstallStop('download_failed', 'the Tailscale package index is not readable');
  }
  const name = packageFromIndex(index, deps.platform, deps.arch);
  if (!name) throw new InstallStop('unsupported', `no Tailscale package for ${deps.platform}-${deps.arch}`);
  const expected = parseSha256File(await downloadText(deps, `${TAILSCALE_PKGS}/${name}.sha256`));
  if (!expected) throw new InstallStop('download_failed', `${name}.sha256 is not a checksum`);
  const bytes = await download(deps, `${TAILSCALE_PKGS}/${name}`, PACKAGE_MAX_BYTES);
  deps.onPhase?.('verifying');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new InstallStop('checksum_mismatch');
  return { name, bytes, sha256: actual };
}

/** File names the desktop app accepts, and nothing else (`desktop/src/tailscale-installer.ts`). */
export const TAILSCALE_PKG_FILE = 'Tailscale.pkg';
export const TAILSCALE_MSI_FILE = 'tailscale-setup.msi';
export const TAILSCALE_TEMP_PREFIX = 'timon-tailscale-';

/**
 * Who opens the installer, decided before anything is downloaded: the daemon
 * when it sits in the user's desktop, the desktop app when it does not and the
 * request came from it, nobody otherwise (the command to run instead).
 */
async function installerLane(deps: TailscaleInstallDeps, delegate: boolean): Promise<'daemon' | 'client'> {
  // `unknown` counts as none: an installer window nobody may see is never reported as opened.
  if (await deps.desktopSession() === 'graphical') return 'daemon';
  if (delegate) return 'client';
  throw new InstallStop('no_desktop');
}

/** The official pkg on disk, checksum and Tailscale Inc.'s Developer ID signature checked. */
async function verifiedMacPkg(deps: TailscaleInstallDeps, dir: string): Promise<{ path: string; sha256: string }> {
  const pkg = await fetchVerifiedPackage(deps);
  const file = join(dir, TAILSCALE_PKG_FILE);
  await deps.writeFile(file, pkg.bytes);
  // portability: macOS-only branch, absolute paths of system tools on purpose
  const check = await deps.exec('/usr/sbin/pkgutil', ['--check-signature', file], VERIFY_TIMEOUT_MS);
  if (check.code !== 0 || !pkgSignedByTailscale(check.stdout)) {
    throw new InstallStop('signature_invalid', firstLine(check.stdout) ?? firstLine(check.stderr));
  }
  return { path: file, sha256: pkg.sha256 };
}

async function openMacPkg(deps: TailscaleInstallDeps, file: string): Promise<void> {
  // `-W`: wait until the Installer quits, so the package is not removed from under it.
  // portability: macOS-only branch
  const opened = await deps.exec('/usr/bin/open', ['-W', file], INSTALLER_TIMEOUT_MS);
  if (opened.code !== 0) throw new InstallStop('installer_failed', firstLine(opened.stderr));
}

/** The official MSI on disk, checksum and Tailscale Inc.'s Authenticode signature checked. */
async function verifiedWindowsMsi(deps: TailscaleInstallDeps, dir: string): Promise<{ path: string; sha256: string }> {
  const pkg = await fetchVerifiedPackage(deps);
  const file = join(dir, TAILSCALE_MSI_FILE);
  await deps.writeFile(file, pkg.bytes);
  const check = await deps.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', authenticodeScript(file)], VERIFY_TIMEOUT_MS);
  if (check.code !== 0 || !msiSignedByTailscale(check.stdout.trim())) {
    throw new InstallStop('signature_invalid', firstLine(check.stderr));
  }
  return { path: file, sha256: pkg.sha256 };
}

async function runWindowsMsi(deps: TailscaleInstallDeps, file: string): Promise<void> {
  // `/passive`: a progress bar and the UAC prompt, no wizard to click through.
  const run = await deps.exec('msiexec.exe', ['/i', file, '/passive', '/norestart'], INSTALLER_TIMEOUT_MS);
  if (MSI_CANCELLED.has(run.code)) throw new InstallStop('cancelled');
  if (!MSI_SUCCESS.has(run.code)) throw new InstallStop('installer_failed', `msiexec exited with ${run.code}`);
}

async function installLinuxScript(deps: TailscaleInstallDeps, dir: string): Promise<void> {
  const pkexec = deps.findBinary('pkexec');
  if (!pkexec) throw new InstallStop('elevation_unavailable');
  deps.onPhase?.('downloading');
  const script = await download(deps, TAILSCALE_INSTALL_SCRIPT, SCRIPT_MAX_BYTES);
  deps.onPhase?.('verifying');
  // No checksum is published for the script: TLS to tailscale.com is its
  // anchor, as for the documented one-liner, and the packages it installs are
  // checked by the distribution's package manager against the vendor's key.
  if (!new TextDecoder().decode(script.slice(0, 2)).startsWith('#!')) {
    throw new InstallStop('download_failed', 'install.sh is not a shell script');
  }
  const installer = join(dir, 'install.sh');
  const wrapper = join(dir, 'timon-install.sh');
  await deps.writeFile(installer, script);
  await deps.writeFile(wrapper, new TextEncoder().encode(linuxElevatedScript(installer, safeOperatorName(deps.username()))));
  deps.onPhase?.('installing');
  // portability: Linux-only branch, the shell the elevated script is written for
  const run = await deps.exec(pkexec, ['/bin/sh', wrapper], INSTALLER_TIMEOUT_MS);
  if (run.code === PKEXEC_DISMISSED) throw new InstallStop('cancelled');
  if (run.code === PKEXEC_NOT_AUTHORIZED) throw new InstallStop('elevation_unavailable', firstLine(run.stderr));
  if (run.code !== 0) {
    const tail = run.stderr.trim().split(/\r?\n/).pop() ?? '';
    throw new InstallStop('installer_failed', firstLine(tail) ?? `exit ${run.code}`);
  }
}

export function installMethodFor(platform: NodeJS.Platform): TailscaleInstallMethod | null {
  if (platform === 'darwin') return 'macos-pkg';
  if (platform === 'win32') return 'windows-msi';
  if (platform === 'linux') return 'linux-script';
  return null;
}

/**
 * Installs Tailscale the official way for this OS. Resolves, never rejects.
 *
 * `delegate`: the request came from the Timon desktop app, which can open an
 * installer in the user's session when the daemon cannot. The package is then
 * verified here and returned as `installer`, its directory left in place for
 * the caller to remove once the app is done with it.
 */
export async function installTailscale(
  deps: TailscaleInstallDeps,
  opts: { delegate?: boolean } = {},
): Promise<TailscaleInstallResult> {
  const method = installMethodFor(deps.platform);
  const command = tailscaleManualInstallCommand(deps.platform);
  if (!method) return { ok: false, reason: 'unsupported', command: null, detail: null };
  let dir: string | null = null;
  let handedOff = false;
  try {
    if (method === 'linux-script') {
      dir = await deps.makeTempDir();
      await installLinuxScript(deps, dir);
      return { ok: true, method };
    }
    const lane = await installerLane(deps, opts.delegate === true);
    dir = await deps.makeTempDir();
    const verified = method === 'macos-pkg' ? await verifiedMacPkg(deps, dir) : await verifiedWindowsMsi(deps, dir);
    if (lane === 'client') {
      handedOff = true;
      return { ok: true, method, installer: { dir, ...verified } };
    }
    deps.onPhase?.('installing');
    if (method === 'macos-pkg') await openMacPkg(deps, verified.path);
    else await runWindowsMsi(deps, verified.path);
    return { ok: true, method };
  } catch (err) {
    if (err instanceof InstallStop) return { ok: false, reason: err.reason, command, detail: err.detail };
    return { ok: false, reason: 'installer_failed', command, detail: firstLine((err as Error).message ?? '') };
  } finally {
    if (dir && !handedOff) await deps.removeDir(dir).catch(() => undefined);
  }
}

/** `tailscale set --operator=<this account>` through pkexec (Linux). */
export async function allowTailscaleOperator(
  deps: Pick<TailscaleInstallDeps, 'exec' | 'findBinary' | 'username'>,
  tailscale: string,
): Promise<{ ok: true } | { ok: false; reason: 'elevation_unavailable' | 'cancelled' | 'failed'; command: string; detail: string | null }> {
  const command = tailscaleManualOperatorCommand();
  const pkexec = deps.findBinary('pkexec');
  const operator = safeOperatorName(deps.username());
  if (!pkexec || !operator) return { ok: false, reason: 'elevation_unavailable', command, detail: null };
  const run = await deps.exec(pkexec, [tailscale, 'set', `--operator=${operator}`], INSTALLER_TIMEOUT_MS);
  if (run.code === 0) return { ok: true };
  if (run.code === PKEXEC_DISMISSED) return { ok: false, reason: 'cancelled', command, detail: null };
  if (run.code === PKEXEC_NOT_AUTHORIZED) return { ok: false, reason: 'elevation_unavailable', command, detail: firstLine(run.stderr) };
  return { ok: false, reason: 'failed', command, detail: firstLine(run.stderr) ?? firstLine(run.stdout) };
}

/** The real machine, minus what only the caller knows (how to exec, the desktop probe, binary lookup). */
export function nodeInstallFs(): Pick<TailscaleInstallDeps, 'makeTempDir' | 'removeDir' | 'writeFile' | 'username' | 'fetcher'> {
  return {
    makeTempDir: () => mkdtemp(join(tmpdir(), TAILSCALE_TEMP_PREFIX)),
    removeDir: (path) => rm(path, { recursive: true, force: true }),
    writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
    username: () => {
      try { return userInfo().username; } catch { return null; }
    },
    fetcher: (url) => fetch(url, { redirect: 'follow' }),
  };
}
