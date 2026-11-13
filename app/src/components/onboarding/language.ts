/**
 * Applies a language the same way Settings does: the `timon-locale` cookie,
 * so the next page the server renders is already in it.
 *
 * Onboarding does not offer a language step. With no cookie, the shell follows
 * the system locale and does not write one.
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
