/**
 * What a web terminal runs: the user's shell, in a cleaned environment.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { findPwsh } from '../../host/powershell.js';
import { settingStr } from '../../settings.js';

/**
 * Login shell of the daemon's user. `$SHELL` is often missing under a
 * service manager (systemd, launchd), so the passwd entry comes next. A
 * login shell (`-l`) reads the profile: without it, PATH is the service's
 * minimal one and half the user's tools are "command not found".
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  pwsh: () => string | null = findPwsh,
): { shell: string; args: string[] } {
  const override = settingStr('ROOKS_TERMINAL_WEB_SHELL').trim();
  if (override) return { shell: override, args: [] };
  if (platform === 'win32') {
    // PowerShell 7 parses `&&` / `||`, the 5.1 that ships with every supported
    // Windows does not (TIM-0085): use 7 when it is installed.
    return { shell: pwsh() ?? 'powershell.exe', args: ['-NoLogo'] };
  }
  let shell = process.env.SHELL?.trim() ?? '';
  if (!shell) {
    try { shell = userInfo().shell ?? ''; } catch { shell = ''; }
  }
  // portability: POSIX-only branch (win32 returned above); /bin/sh exists on Linux and macOS.
  return { shell: shell || '/bin/sh', args: ['-l'] };
}

/**
 * Daemon variables never reach the shell. `ROOKS_*` carries the daemon's own
 * wiring (and possibly tokens); `NODE_ENV=production` would leak into every
 * `npm` the user runs; `ELECTRON_RUN_AS_NODE` turns any Electron app launched
 * from the shell into a bare Node.
 */
const STRIPPED_KEYS = new Set(['NODE_ENV', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'INVOCATION_ID', 'JOURNAL_STREAM']);

export function shellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.startsWith('ROOKS_') || STRIPPED_KEYS.has(key)) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export function defaultCwd(): string {
  const home = homedir();
  try {
    if (existsSync(home) && statSync(home).isDirectory()) return home;
  } catch { /* fall through */ }
  return process.cwd();
}
