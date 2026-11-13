/**
 * Which language the shell speaks: the one picked in the app, else the OS's.
 *
 * The app stores the choice in the `rooks-locale` cookie of the page's
 * session (docs/I18N.md); the windows load in the default session, so the
 * shell reads that cookie there — no preload, no IPC, nothing the page has
 * to know about Electron. "System language" removes the cookie: the shell
 * then negotiates the OS's preferred languages, as the app does with the
 * `Accept-Language` Chromium derives from them.
 */
import { canonicalTag } from './i18n-core.js';
import { resolveShellLocale } from './shell-i18n.js';

/** Copy of `LOCALE_COOKIE` in `app/src/lib/locale-preference.ts`; `shell-i18n.test.ts` compares both. */
export const LOCALE_COOKIE = 'rooks-locale';

export type LocaleCookie = { name: string; value: string; domain?: string };

/** The tag a cookie asks for, or `null` for `auto` and anything not a tag. */
export function cookieTag(value: string): string | null {
  return value === 'auto' ? null : canonicalTag(value.trim());
}

/**
 * Cookies are per host, not per port: the installed daemon and the sandbox
 * share `localhost` (wanted), but a window may also have shown another
 * machine. The cookie of the daemon's own host wins, then the first one.
 */
export function pickLocaleCookie(cookies: readonly LocaleCookie[], host: string | null): string | null {
  const named = cookies.filter((cookie) => cookie.name === LOCALE_COOKIE);
  const own = host ? named.find((cookie) => (cookie.domain ?? '').replace(/^\./, '') === host) : undefined;
  const chosen = own ?? named[0];
  return chosen ? cookieTag(chosen.value) : null;
}

/** The languages asked for, in order: the app's choice, then the OS's. */
export function localeRequest(choice: string | null, system: readonly string[]): string[] {
  return choice ? [choice, ...system] : [...system];
}

/**
 * The shell's current language. `onChange` runs only when the resolved
 * language actually changes: menus, tray, Dock and jump list are rebuilt
 * then, the windows already open keep their text.
 */
export class ShellLocale {
  private choice: string | null = null;
  current: string;

  constructor(private readonly system: () => readonly string[], private readonly onChange: (tag: string) => void = () => {}) {
    this.current = resolveShellLocale(system());
  }

  /** At startup: every `rooks-locale` cookie of the session. */
  load(cookies: readonly LocaleCookie[], host: string | null): void {
    this.choice = pickLocaleCookie(cookies, host);
    this.update();
  }

  /**
   * A cookie of the session changed (`session.cookies` `changed`). An
   * overwrite arrives as a removal then the new value: the removal half
   * is skipped, or the shell would flash the OS's language in between.
   */
  changed(cookie: LocaleCookie, removed: boolean, cause?: string): void {
    if (cookie.name !== LOCALE_COOKIE) return;
    if (removed && cause === 'overwrite') return;
    this.choice = removed ? null : cookieTag(cookie.value);
    this.update();
  }

  private update(): void {
    const next = resolveShellLocale(localeRequest(this.choice, this.system()));
    if (next === this.current) return;
    this.current = next;
    this.onChange(next);
  }
}
