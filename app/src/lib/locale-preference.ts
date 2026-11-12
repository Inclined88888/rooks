/**
 * How the interface language is chosen: the reader's explicit choice (a
 * cookie, so the server renders the first frame in it, login included), else
 * the languages the browser asks for (`Accept-Language`, which the desktop
 * app derives from the OS), else English. Rules: docs/I18N.md, Negotiation.
 *
 * A cookie rather than an account preference: the login screen needs the
 * language before anyone is signed in, and the choice belongs to the screen
 * being read, like the browser's own language.
 */
import { DEFAULT_LOCALE, availableLocales, type LocaleInfo, type Locale } from './i18n';
import { canonicalTag, negotiate, parseAcceptLanguage } from './i18n-core';

export const LOCALE_COOKIE = 'rooks-locale';

/** `auto` follows the browser (and the OS); a tag pins a language present. */
export type LocaleChoice = 'auto' | Locale;

/**
 * The languages offered: every language present, whatever its coverage (a
 * missing message reads in English). English first, then by tag. The
 * selector lists them, and `auto` negotiates among them.
 */
export function selectableLocales(catalog: readonly LocaleInfo[] = availableLocales()): LocaleInfo[] {
  return [...catalog].sort((a, b) => (a.tag === DEFAULT_LOCALE ? -1 : b.tag === DEFAULT_LOCALE ? 1 : a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

/**
 * The cookie's value: a well-formed tag that resolves to a language present
 * (`pt` reads `pt-BR`), kept as written; anything else — absent, stale,
 * forged — is `auto`.
 */
export function parseLocaleChoice(value: string | null | undefined, catalog: readonly LocaleInfo[] = availableLocales()): LocaleChoice {
  const tag = canonicalTag(value);
  if (!tag) return 'auto';
  return negotiate([tag], catalog) ? tag : 'auto';
}

/**
 * The language of an `Accept-Language` header (or of the browser's list of
 * languages): the first one asked for that resolves, region included —
 * `fr-CA` reads French, `pt-PT` the Brazilian Portuguese — else English.
 */
export function negotiateLocale(
  acceptLanguage: string | readonly string[] | null | undefined,
  catalog: readonly LocaleInfo[] = availableLocales(),
): Locale {
  const requested = typeof acceptLanguage === 'string' || acceptLanguage == null
    ? parseAcceptLanguage(acceptLanguage)
    : acceptLanguage;
  return negotiate(requested, catalog) ?? DEFAULT_LOCALE;
}

export function resolveLocale(
  choice: LocaleChoice,
  acceptLanguage: string | null | undefined,
  catalog: readonly LocaleInfo[] = availableLocales(),
): Locale {
  if (choice === 'auto') return negotiateLocale(acceptLanguage, catalog);
  return negotiate([choice], catalog) ?? negotiateLocale(acceptLanguage, catalog);
}

/** What the browser stores for a choice; `auto` removes the cookie. */
export function localeCookie(choice: LocaleChoice): string {
  const tag = choice === 'auto' ? null : canonicalTag(choice);
  return tag === null
    ? `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    : `${LOCALE_COOKIE}=${tag}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** The choice stored in a `document.cookie` string. */
export function readLocaleChoice(cookieHeader: string, catalog: readonly LocaleInfo[] = availableLocales()): LocaleChoice {
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === LOCALE_COOKIE) return parseLocaleChoice(rest.join('='), catalog);
  }
  return 'auto';
}
