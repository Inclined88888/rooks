/**
 * The welcome screen's language, applied live: the roller turns, the screen
 * changes language under the reader's eyes, no reload.
 *
 * The same cookie as Settings › Language (`lib/locale-preference.ts`), so the
 * next page the server renders — the login, `/setup` — is already in it.
 */
import { getLocale, loadLocale, localeDirection, type Locale } from '@/lib/i18n';
import { localeCookie } from '@/lib/locale-preference';

/** What the language is written to: `document` in the browser, a stand-in in the tests. */
export type LanguageTarget = {
  cookie: string;
  documentElement: { lang: string; dir: string };
};

/**
 * Loads `tag`, switches every `t()` to it and stores the choice. A language
 * that fails to load keeps the current one: the screen stays readable.
 */
export async function applyLanguage(tag: Locale, target: LanguageTarget): Promise<Locale> {
  try {
    await loadLocale(tag);
  } catch {
    return getLocale();
  }
  const active = getLocale();
  target.cookie = localeCookie(active);
  target.documentElement.lang = active;
  target.documentElement.dir = localeDirection(active);
  return active;
}

/** How long the roller rests on a language before the screen switches to it. */
export const LANGUAGE_DWELL_MS = 120;

export type LanguageDwell = {
  /** The roller's middle row is now `tag`: applied if it is still there after the dwell. */
  cross: (tag: string) => void;
  /** The roller came to rest on `tag` (released, or a click): applied now, once. */
  rest: (tag: string) => void;
  /** Applies a language still waiting for its dwell, then stops: the reader saw it in the middle. */
  flush: () => void;
};

type DwellTimers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const windowTimers: DwellTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The roller stays live — the screen follows the language it rests on — but a
 * drag across six rows must not fetch six catalogues: a language is applied
 * after a short rest on it, or when the roller stops, and never twice in a row.
 */
export function languageDwell(
  initial: string,
  apply: (tag: string) => void,
  { delayMs = LANGUAGE_DWELL_MS, timers = windowTimers }: { delayMs?: number; timers?: DwellTimers } = {},
): LanguageDwell {
  let applied = initial;
  let pending: string | null = null;
  let handle: unknown = null;

  const cancel = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  const commit = (tag: string): void => {
    cancel();
    pending = null;
    if (tag === applied) return;
    applied = tag;
    apply(tag);
  };

  return {
    cross: (tag) => {
      cancel();
      pending = tag;
      handle = timers.set(() => { handle = null; commit(tag); }, delayMs);
    },
    rest: commit,
    flush: () => { if (pending !== null) commit(pending); },
  };
}
