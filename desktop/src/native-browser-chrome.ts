/**
 * Pure parts of the "sign in with Chrome" flow (TODO #276): which binary may be
 * launched, with which flags, how its DevTools pipe is framed, and how its
 * cookies map onto an Electron session.
 *
 * Google rejects the Electron engine at sign-in whatever it presents, but
 * accepts an installed Chrome driven over `--remote-debugging-pipe` with the
 * automation flag off (measured 12/10/2026, docs/PROGRESS.md TIM-0075/#276).
 * Cookie values pass through here and are never logged.
 */
import { basename, isAbsolute, win32 } from 'node:path';
import type { CookiesSetDetails } from 'electron';
import { isCookieHost, KEPT_SESSION_COOKIE_DAYS } from './native-browser-cookies.js';

/**
 * Basenames the shell agrees to launch. Closed on purpose: the daemon names the
 * binary, and a command that can start any file would be an execution
 * primitive. Same list as `CHROME_EXECUTABLE_NAMES` in
 * `orchestrator/src/host/chrome-binary.ts` (held equal by a test there).
 */
export const CHROME_EXECUTABLE_NAMES: readonly string[] = [
  'google-chrome', 'google-chrome-stable', 'google chrome', 'chrome.exe', 'chrome',
  'microsoft-edge', 'microsoft-edge-stable', 'microsoft edge', 'msedge.exe', 'msedge',
  'chromium', 'chromium-browser',
];

export const DEFAULT_SIGNIN_URL = 'https://accounts.google.com/';

/** True for an absolute path whose file name is on the closed list. Existence is checked by the caller. */
export function acceptableChromeExecutable(file: unknown, platform: NodeJS.Platform = process.platform): file is string {
  if (typeof file !== 'string' || file.length === 0 || file.length > 1024 || file.includes('\0')) return false;
  const absolute = platform === 'win32' ? win32.isAbsolute(file) : isAbsolute(file);
  if (!absolute) return false;
  const name = (platform === 'win32' ? win32.basename(file) : basename(file)).toLowerCase();
  return CHROME_EXECUTABLE_NAMES.includes(name);
}

/**
 * `--disable-blink-features=AutomationControlled` is the one that matters:
 * `--remote-debugging-pipe` alone leaves `navigator.webdriver` true and Google
 * rejects that too. `--enable-automation` is deliberately absent (it adds the
 * "controlled by automated software" bar the user would see). The keychain and
 * password-store flags keep a first launch from opening an OS keyring prompt.
 */
export function chromeLaunchArguments(userDataDir: string, url: string): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    url,
  ];
}

/**
 * The environment the browser is started with: Rooks's own, minus what only makes
 * sense for Electron. Under an AppImage, `LD_LIBRARY_PATH` points into the image and
 * a system Chrome would load Electron's libraries instead of its own.
 */
export function chromeEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === 'CHROME_DESKTOP' || name === 'NODE_OPTIONS' || name.startsWith('ELECTRON_')) continue;
    clean[name] = value;
  }
  const image = env.APPDIR;
  if (platform === 'linux' && image && clean.LD_LIBRARY_PATH) {
    const kept = clean.LD_LIBRARY_PATH.split(':').filter((entry) => entry && !entry.startsWith(image));
    if (kept.length) clean.LD_LIBRARY_PATH = kept.join(':');
    else delete clean.LD_LIBRARY_PATH;
  }
  return clean;
}

/** Messages on the DevTools pipe are JSON texts each terminated by a NUL byte. */
export class PipeFrames {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: string[] = [];
    let start = 0;
    for (let end = this.buffer.indexOf(0, start); end !== -1; end = this.buffer.indexOf(0, start)) {
      if (end > start) messages.push(this.buffer.toString('utf8', start, end));
      start = end + 1;
    }
    this.buffer = this.buffer.subarray(start);
    if (this.buffer.length > this.maxBytes) throw new Error('DevTools message is too large.');
    return messages;
  }
}

export const framePipeMessage = (message: unknown): Buffer => Buffer.from(`${JSON.stringify(message)}\0`, 'utf8');

/** A cookie as `Storage.getCookies` reports it. Only the fields the import reads. */
export interface ChromeCookie {
  name: string; value: string; domain: string; path: string;
  expires?: number; session?: boolean; secure?: boolean; httpOnly?: boolean;
  sameSite?: string; partitionKey?: unknown;
}

const SAME_SITE: Record<string, CookiesSetDetails['sameSite']> = {
  Strict: 'strict', Lax: 'lax', None: 'no_restriction',
};

/**
 * The Electron-side twin of a Chrome cookie, or null when its scope cannot be
 * rebuilt exactly (a wrong copy would widen the cookie to hosts or paths the
 * site never granted). Partitioned cookies are skipped: Electron 33 cannot
 * set a partition key.
 */
export function electronCookieFrom(cookie: ChromeCookie, now = Date.now()): CookiesSetDetails | null {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') return null;
  if (cookie.partitionKey !== undefined) return null;
  const sameSite = cookie.sameSite === undefined ? 'unspecified' : SAME_SITE[cookie.sameSite];
  if (!sameSite) return null;
  const hostOnly = !cookie.domain.startsWith('.');
  const host = hostOnly ? cookie.domain : cookie.domain.slice(1);
  if (!isCookieHost(host)) return null;
  const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  const secure = cookie.secure === true;
  if (cookie.name.startsWith('__Host-') && (!hostOnly || path !== '/' || !secure)) return null;
  if (cookie.name.startsWith('__Secure-') && !secure) return null;
  if (sameSite === 'no_restriction' && !secure) return null;
  let url: string;
  try { url = new URL(`${secure ? 'https' : 'http'}://${host}${path}`).href; } catch { return null; }
  const persistent = cookie.session !== true && typeof cookie.expires === 'number' && cookie.expires > 0;
  if (persistent && cookie.expires! * 1000 <= now) return null;
  return {
    url, name: cookie.name, value: cookie.value, path, secure, httpOnly: cookie.httpOnly === true, sameSite,
    ...(hostOnly ? {} : { domain: `.${host}` }),
    // A session cookie is kept for as long as the longest cookie a site may set: the same rule
    // as TIM-0075, so a sign-in survives a restart of the app.
    expirationDate: persistent ? cookie.expires! : Math.floor(now / 1000) + KEPT_SESSION_COOKIE_DAYS * 86_400,
  };
}
