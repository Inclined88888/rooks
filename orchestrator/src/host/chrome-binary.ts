/**
 * Finds a Chromium-family browser installed on the machine, for the embedded
 * browser's "sign in with Chrome" flow (TODO #276).
 *
 * Google refuses to sign anyone in from the Electron engine itself, whatever
 * the user agent says, but accepts an installed Chrome. The desktop launches
 * the binary this module resolves; the daemon never starts it.
 *
 * Preference order: Chrome, then Edge, then Chromium. A Chromium shipped as a
 * snap or a flatpak is reported apart and never launched: the sandbox of
 * those packagings cannot write a hidden directory of the user's home, which
 * is where Timon keeps the profile.
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, win32 } from 'node:path';

export type ChromeFlavour = 'chrome' | 'edge' | 'chromium';

export type ChromeBinary = {
  path: string;
  flavour: ChromeFlavour;
  /** Name shown to the user. Never the path: it carries the account name. */
  name: string;
};

export type ChromeDetection =
  | { found: true; binary: ChromeBinary }
  | { found: false; reason: 'none' | 'confined' };

export type ChromeProbe = {
  /** True for an existing executable regular file. */
  executable(file: string): boolean;
  /** Symlinks resolved; the input when it cannot be resolved. */
  realpath(file: string): string;
  /** First bytes of a file as text; '' when unreadable. */
  head(file: string, bytes: number): string;
};

export type ChromeSearchOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  probe?: ChromeProbe;
};

const NAMES: Record<ChromeFlavour, string> = { chrome: 'Google Chrome', edge: 'Microsoft Edge', chromium: 'Chromium' };

export const diskChromeProbe: ChromeProbe = {
  executable: (file) => {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch { return false; }
  },
  realpath: (file) => { try { return realpathSync(file); } catch { return file; } },
  head: (file, bytes) => {
    try { return readFileSync(file).subarray(0, bytes).toString('utf8'); } catch { return ''; }
  },
};

/** Basenames the desktop accepts when asked to launch a binary (see `native-browser-chrome.ts`). */
export const CHROME_EXECUTABLE_NAMES = [
  'google-chrome', 'google-chrome-stable', 'google chrome', 'chrome.exe', 'chrome',
  'microsoft-edge', 'microsoft-edge-stable', 'microsoft edge', 'msedge.exe', 'msedge',
  'chromium', 'chromium-browser',
] as const;

type Candidate = { flavour: ChromeFlavour; file: string };

function candidates(
  platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string,
): Candidate[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA]
      .filter((root): root is string => !!root && win32.isAbsolute(root));
    const under = (flavour: ChromeFlavour, ...parts: string[]): Candidate[] =>
      [...new Set(roots)].map((root) => ({ flavour, file: win32.join(root, ...parts) }));
    return [
      ...under('chrome', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...under('edge', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...under('chromium', 'Chromium', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', ...(home ? [join(home, 'Applications')] : [])];
    const bundle = (flavour: ChromeFlavour, app: string, executable: string): Candidate[] =>
      apps.map((dir) => ({ flavour, file: join(dir, `${app}.app`, 'Contents', 'MacOS', executable) }));
    return [
      ...bundle('chrome', 'Google Chrome', 'Google Chrome'),
      ...bundle('edge', 'Microsoft Edge', 'Microsoft Edge'),
      ...bundle('chromium', 'Chromium', 'Chromium'),
    ];
  }
  const path = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const named = (flavour: ChromeFlavour, names: string[]): Candidate[] =>
    names.flatMap((name) => path.map((dir) => ({ flavour, file: join(dir, name) })));
  return [
    ...named('chrome', ['google-chrome-stable', 'google-chrome']),
    { flavour: 'chrome', file: join('/opt', 'google', 'chrome', 'chrome') },
    ...named('edge', ['microsoft-edge-stable', 'microsoft-edge']),
    { flavour: 'edge', file: join('/opt', 'microsoft', 'msedge', 'msedge') },
    ...named('chromium', ['chromium', 'chromium-browser']),
  ];
}

/** Packagings whose sandbox cannot reach `~/.timon`: snap, flatpak, and Ubuntu's `chromium-browser` stub that launches the snap. */
function isConfined(file: string, probe: ChromeProbe): boolean {
  const resolved = probe.realpath(file).replace(/\\/g, '/');
  if (/^\/(snap|var\/lib\/snapd|var\/lib\/flatpak|usr\/share\/flatpak)\//.test(resolved)
    || resolved.includes('/.local/share/flatpak/')) return true;
  // The stub is a short shell script naming snap, not an ELF binary.
  const start = probe.head(file, 2048);
  return start.startsWith('#!') && /\bsnap\b/.test(start);
}

export function detectChromeBinary(options: ChromeSearchOptions = {}): ChromeDetection {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? diskChromeProbe;
  const override = env.TIMON_CHROME_PATH?.trim();
  const list: Array<Candidate & { pinned?: boolean }> = [];
  if (override) list.push({ flavour: flavourOfPath(override), file: override, pinned: true });
  list.push(...candidates(platform, env, options.homeDir ?? homedir()));
  let confined = false;
  const seen = new Set<string>();
  for (const { flavour, file, pinned } of list) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!probe.executable(file)) continue;
    // A binary the user pinned by hand is theirs to vouch for.
    if (platform === 'linux' && !pinned && isConfined(file, probe)) { confined = true; continue; }
    return { found: true, binary: { path: file, flavour, name: NAMES[flavour] } };
  }
  return { found: false, reason: confined ? 'confined' : 'none' };
}

function flavourOfPath(file: string): ChromeFlavour {
  const lower = file.toLowerCase();
  return lower.includes('edge') ? 'edge' : lower.includes('chromium') ? 'chromium' : 'chrome';
}
