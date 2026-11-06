import { posix, win32 } from 'node:path';

/**
 * "Install Tailscale" when the daemon has no desktop: the packaged daemon
 * runs in Windows session 0 (S4U task) or as a macOS LaunchDaemon, where an
 * installer window is invisible. The daemon downloads the official package and
 * verifies it (sha256, Developer ID or Authenticode signature of Tailscale
 * Inc.) — `orchestrator/src/host/tailscale-install.ts` — then stops at a
 * `handoff`; this process, in the user's session, opens it.
 *
 * The renderer is NOT trusted with a path: the channel takes no argument. This
 * process reads the job from the daemon with the user's session cookie, as for
 * `reveal-path.ts`, accepts only the file names and directory the daemon
 * writes, checks the sha256 the daemon verified once more against the bytes on
 * disk, opens the installer and reports how it ended (the daemon then removes
 * the file).
 */
export const TAILSCALE_INSTALLER_CHANNEL = 'timon:tailscale-installer';
export const TAILSCALE_OPEN_APP_CHANNEL = 'timon:tailscale-open-app';

/** Same names as `orchestrator/src/host/tailscale-install.ts` (the two packages are independent). */
const PKG_FILE = 'Tailscale.pkg';
const MSI_FILE = 'tailscale-setup.msi';
const TEMP_PREFIX = 'timon-tailscale-';
/** msiexec: cancelled by the person (1602), UAC refused (1223); 3010 = installed, reboot pending. */
const MSI_CANCELLED: ReadonlySet<number> = new Set([1602, 1223]);
const MSI_SUCCESS: ReadonlySet<number> = new Set([0, 3010]);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PATH_LENGTH = 4096;
/** The standalone app, where its installer puts it; nothing from the daemon decides this path. */
// portability: macOS-only location of the Tailscale app
export const TAILSCALE_MAC_APP = '/Applications/Tailscale.app';

export type InstallerOutcome =
  | { status: 'installed' }
  | { status: 'cancelled' }
  /** The daemon has no verified package waiting for this app. */
  | { status: 'none' }
  /** This package is already open in an installer. */
  | { status: 'busy' }
  | { status: 'failed'; message: string | null };

export type OpenAppOutcome = { status: 'opened' } | { status: 'missing' } | { status: 'unsupported' } | { status: 'failed'; message: string | null };

export type TailscaleInstallerDeps = {
  platform: NodeJS.Platform;
  /** `GET /api/ui/devices/tailscale` with the user's session; `body` null when not JSON. */
  readStatus: () => Promise<{ status: number; body: unknown }>;
  /** `POST /api/ui/devices/tailscale/install/report`, same session. */
  report: (body: { sha256: string; outcome: 'installed' | 'cancelled' | 'failed'; code?: number }) => Promise<void>;
  /** `lstat`: `null` when the path does not exist. */
  lstat: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean } | null;
  sha256File: (path: string) => Promise<string>;
  /** Runs a binary with an argv and waits for it; `code` null when it could not start. */
  run: (file: string, args: string[]) => Promise<{ code: number | null; error: string | null }>;
  /** `%SystemRoot%`, for msiexec's absolute path (never a PATH lookup). */
  systemRoot: string | null;
  exists: (path: string) => boolean;
};

type Sender = { isWindow: boolean; isMainFrame: boolean; url: string };

export function trustedSender(sender: Sender, uiOrigin: string): boolean {
  try {
    return sender.isWindow && sender.isMainFrame && new URL(sender.url).origin === new URL(uiOrigin).origin;
  } catch {
    return false;
  }
}

/** The handed-over package in a status reply, or `null` when there is none to open. */
export function handoffOf(body: unknown): { path: string; sha256: string } | null {
  const job = (body && typeof body === 'object' ? (body as { job?: unknown }).job : null) as
    { kind?: unknown; phase?: unknown; installer?: unknown } | null | undefined;
  if (!job || job.kind !== 'install' || job.phase !== 'handoff') return null;
  const installer = (job.installer && typeof job.installer === 'object' ? job.installer : {}) as { path?: unknown; sha256?: unknown };
  if (typeof installer.path !== 'string' || typeof installer.sha256 !== 'string' || !SHA256.test(installer.sha256)) return null;
  return { path: installer.path, sha256: installer.sha256 };
}

/**
 * Only the file the daemon writes: its exact name for this OS, directly in a
 * directory it created (`timon-tailscale-…`), absolute, never a network path.
 */
export function acceptedInstallerPath(path: string, platform: NodeJS.Platform): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\0')) return false;
  if (platform === 'darwin') {
    return posix.isAbsolute(path) && posix.normalize(path) === path
      && posix.basename(path) === PKG_FILE && posix.basename(posix.dirname(path)).startsWith(TEMP_PREFIX);
  }
  if (platform === 'win32') {
    // `\\host\share` and `\\?\…` make Windows reach out to another machine.
    if (/^[\\/]{2}/.test(path) || !/^[A-Za-z]:\\/.test(path)) return false;
    return win32.normalize(path) === path
      && win32.basename(path) === MSI_FILE && win32.basename(win32.dirname(path)).startsWith(TEMP_PREFIX);
  }
  return false;
}

export class TailscaleInstaller {
  /** Packages open in an installer right now: a reloaded page never opens a second one. */
  private readonly opened = new Set<string>();

  constructor(private readonly deps: TailscaleInstallerDeps) {}

  async openInstaller(sender: Sender, uiOrigin: string): Promise<InstallerOutcome> {
    if (!trustedSender(sender, uiOrigin)) throw new Error('Installing Tailscale is only available from Timon.');
    const { platform } = this.deps;
    if (platform !== 'darwin' && platform !== 'win32') return { status: 'none' };

    let reply: { status: number; body: unknown };
    try {
      reply = await this.deps.readStatus();
    } catch (err) {
      return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
    if (reply.status !== 200) return { status: 'failed', message: null };
    const handoff = handoffOf(reply.body);
    if (!handoff) return { status: 'none' };
    if (this.opened.has(handoff.sha256)) return { status: 'busy' };
    // Claimed before the first await below, released once the installer is gone:
    // a later attempt downloads the same version again, same sha256, a new job.
    this.opened.add(handoff.sha256);
    try {
      return await this.verifyAndOpen(handoff, platform);
    } finally {
      this.opened.delete(handoff.sha256);
    }
  }

  private async verifyAndOpen(handoff: { path: string; sha256: string }, platform: 'darwin' | 'win32'): Promise<InstallerOutcome> {
    // Every refusal is reported: the daemon closes the job and removes the file at once.
    const refuse = async (message: string): Promise<InstallerOutcome> => {
      await this.deps.report({ sha256: handoff.sha256, outcome: 'failed' }).catch(() => undefined);
      return { status: 'failed', message };
    };
    if (!acceptedInstallerPath(handoff.path, platform)) return refuse('Unexpected installer path.');
    const stat = this.deps.lstat(handoff.path);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return refuse('The installer is missing.');
    // The daemon verified these bytes; the file must still be them.
    let actual: string;
    try {
      actual = await this.deps.sha256File(handoff.path);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    if (actual !== handoff.sha256) return refuse('The installer changed after it was verified.');
    const outcome = platform === 'darwin' ? await this.openPkg(handoff.path) : await this.runMsi(handoff.path);
    const status = outcome.result.status === 'installed' || outcome.result.status === 'cancelled' ? outcome.result.status : 'failed';
    await this.deps.report({ sha256: handoff.sha256, outcome: status, ...(outcome.code === null ? {} : { code: outcome.code }) })
      .catch(() => undefined);
    return outcome.result;
  }

  private async openPkg(path: string): Promise<{ result: InstallerOutcome; code: number | null }> {
    // `-W`: wait until the Installer quits, so the package is not removed from under it.
    // portability: macOS-only branch, the system `open`
    const run = await this.deps.run('/usr/bin/open', ['-W', path]);
    if (run.code === 0) return { result: { status: 'installed' }, code: 0 };
    return { result: { status: 'failed', message: run.error }, code: run.code };
  }

  private async runMsi(path: string): Promise<{ result: InstallerOutcome; code: number | null }> {
    if (!this.deps.systemRoot || !win32.isAbsolute(this.deps.systemRoot)) {
      return { result: { status: 'failed', message: 'SystemRoot is not set.' }, code: null };
    }
    // `/passive`: a progress bar and the UAC prompt, no wizard to click through.
    const run = await this.deps.run(win32.join(this.deps.systemRoot, 'System32', 'msiexec.exe'), ['/i', path, '/passive', '/norestart']);
    if (run.code !== null && MSI_SUCCESS.has(run.code)) return { result: { status: 'installed' }, code: run.code };
    if (run.code !== null && MSI_CANCELLED.has(run.code)) return { result: { status: 'cancelled' }, code: run.code };
    return { result: { status: 'failed', message: run.error ?? (run.code === null ? null : `msiexec exited with ${run.code}`) }, code: run.code };
  }

  /**
   * macOS: the standalone app owns the Tailscale node, and a LaunchDaemon's
   * `open -a` never reaches the user's session. A fixed path, nothing asked.
   */
  async openApp(sender: Sender, uiOrigin: string): Promise<OpenAppOutcome> {
    if (!trustedSender(sender, uiOrigin)) throw new Error('Opening Tailscale is only available from Timon.');
    if (this.deps.platform !== 'darwin') return { status: 'unsupported' };
    if (!this.deps.exists(TAILSCALE_MAC_APP)) return { status: 'missing' };
    // portability: macOS-only branch, the system `open`
    const run = await this.deps.run('/usr/bin/open', ['-a', TAILSCALE_MAC_APP]);
    return run.code === 0 ? { status: 'opened' } : { status: 'failed', message: run.error };
  }
}
