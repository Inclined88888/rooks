import { execFile } from 'node:child_process';

/**
 * Whether the process runs in a session that has a desktop a window can appear
 * on. `unknown` is not a guess to round up: callers treat it as `none`, since a
 * window that may be invisible must never be reported as opened.
 */
export type DesktopSession = 'graphical' | 'none' | 'unknown';

/** Runs a probe command and resolves with its stdout; rejects when it cannot run. */
export type SessionProbe = (file: string, args: string[]) => Promise<string>;

const PROBE_TIMEOUT_MS = 5_000;

export const probeSession: SessionProbe = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(String(stdout));
  });
});

/**
 * The scheduled task that keeps the daemon alive (LogonType=S4U) and a macOS
 * LaunchDaemon both run outside the user's desktop: whatever they launch has
 * no window anyone can see. Asking the OS is the only reliable signal — the
 * same binary also runs inside the user's session (embedded daemon, terminal).
 *
 * - Windows: the session id of this very process; 0 is the non-interactive
 *   services session, every logged-on user session is 1 or more.
 * - macOS: `launchctl managername` names the launchd domain this process lives
 *   in — `Aqua` for a graphical login, `System` under a LaunchDaemon.
 */
export async function detectDesktopSession(
  platform: NodeJS.Platform,
  probe: SessionProbe = probeSession,
  pid: number = process.pid,
): Promise<DesktopSession> {
  try {
    if (platform === 'win32') {
      const out = (await probe('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)}).SessionId`,
      ])).trim();
      if (out === '0') return 'none';
      return /^[1-9]\d*$/.test(out) ? 'graphical' : 'unknown';
    }
    if (platform === 'darwin') {
      // portability: macOS-only branch, absolute path on purpose
      const name = (await probe('/bin/launchctl', ['managername'])).trim();
      if (!name) return 'unknown';
      return name === 'Aqua' ? 'graphical' : 'none';
    }
  } catch { /* probe unavailable → unknown */ }
  return 'unknown';
}
