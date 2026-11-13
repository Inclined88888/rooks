/**
 * The webview's i18n — a plain module function, not a hook or context: this
 * is App Router, and a hook-based `t()` would break every Server Component
 * that needs it. Contract and reasons: docs/I18N.md.
 *
 * No language is listed here. The languages present are the folders of
 * `src/locales/` that hold a `meta.json`; `scripts/build-locales.mjs` turns
 * them into the generated catalog and English index read below.
 *
 * English ships with the bundle (`t()` is synchronous and some modules call
 * it while they load); every other language loads on demand through the
 * loader of the side it runs on: `fetch` in the browser, the disk on the
 * server (`locale-server.ts`), the sources in the tests (`i18n-sources.ts`).
 */
import { EN_NAMESPACES } from '@/locales/.generated/en';
import { LOCALE_CATALOG } from '@/locales/.generated/catalog';
import {
  SOURCE_LOCALE, localeChain, lookup, mergeDictionaries, translate,
  type Dictionary, type LocaleInfo, type LocaleLayer, type MessageVars, type TextDirection,
} from './i18n-core';

export type { Dictionary, LocaleInfo, TextDirection } from './i18n-core';
export { mergeDictionaries } from './i18n-core';

/** A canonical BCP 47 tag of a language present (`en`, `fr`, `pt-BR`). */
export type Locale = string;
export type LocaleTag = Locale;

export const DEFAULT_LOCALE: Locale = SOURCE_LOCALE;

/** Fetches the merged dictionary of one language. */
export type LocaleLoader = (info: LocaleInfo) => Promise<Dictionary>;

interface SharedState {
  dictionaries: Map<Locale, Dictionary>;
  pending: Map<Locale, Promise<void>>;
  loader: LocaleLoader | null;
  catalog: readonly LocaleInfo[];
}

/**
 * On the server, Server Components and the client components rendered there
 * live in two module graphs, each with its copy of this module, in ONE
 * process. Keeping the dictionaries on `globalThis` lets the client graph
 * render in the language the root layout already loaded, without a second
 * read and without a fetch the server could not make. The current locale
 * stays per graph (`LocaleProvider` sets the client one).
 */
const STATE_KEY = Symbol.for('rooks.i18n');

function shared(): SharedState {
  const scope = globalThis as unknown as Record<symbol, SharedState | undefined>;
  let state = scope[STATE_KEY];
  if (!state) {
    state = {
      dictionaries: new Map([[SOURCE_LOCALE, mergeDictionaries(...(EN_NAMESPACES as Dictionary[]))]]),
      pending: new Map(),
      loader: null,
      catalog: LOCALE_CATALOG,
    };
    scope[STATE_KEY] = state;
  }
  return state;
}

let currentLocale: Locale = DEFAULT_LOCALE;

/** The browser's loader: an immutable URL per content hash, cached at will. */
const fetchLoader: LocaleLoader = async (info) => {
  const response = await fetch(`/locales/${encodeURIComponent(info.tag)}.json?v=${encodeURIComponent(info.hash)}`);
  if (!response.ok) throw new Error(`locale ${info.tag}: HTTP ${response.status}`);
  return (await response.json()) as Dictionary;
};

function activeLoader(): LocaleLoader {
  const { loader } = shared();
  if (loader) return loader;
  if (typeof window !== 'undefined') return fetchLoader;
  throw new Error('no locale loader on this side: the server registers one in locale-server.ts');
}

/** Where the dictionaries of the other languages come from on this side. */
export function setLocaleLoader(loader: LocaleLoader | null): void {
  shared().loader = loader;
}

/** The languages present: code, native name, writing direction, coverage. */
export function availableLocales(): readonly LocaleInfo[] {
  return shared().catalog;
}

/** Replaces the catalog (tests, tooling): the build normally writes it. */
export function setLocaleCatalog(catalog: readonly LocaleInfo[]): void {
  shared().catalog = catalog;
}

export function localeInfo(tag: Locale): LocaleInfo | undefined {
  return shared().catalog.find((info) => info.tag === tag);
}

/** The writing direction of a language, for `<html dir>`. */
export function localeDirection(tag: Locale): TextDirection {
  return localeInfo(tag)?.dir ?? 'ltr';
}

export function registerLocale(tag: Locale, dictionary: Dictionary): void {
  shared().dictionaries.set(tag, dictionary);
}

export function isLocaleLoaded(tag: Locale): boolean {
  return shared().dictionaries.has(tag);
}

/** Switches to a language already loaded; one that is not keeps the current one. */
export function setLocale(tag: Locale): void {
  if (isLocaleLoaded(tag)) currentLocale = tag;
}

export function getLocale(): Locale {
  return currentLocale;
}

function ensureLoaded(tag: Locale): Promise<void> {
  const state = shared();
  if (state.dictionaries.has(tag)) return Promise.resolve();
  const info = localeInfo(tag);
  if (!info) return Promise.resolve();
  let pending = state.pending.get(tag);
  if (!pending) {
    pending = activeLoader()(info)
      .then((dictionary) => { state.dictionaries.set(tag, dictionary); })
      .finally(() => { state.pending.delete(tag); });
    state.pending.set(tag, pending);
  }
  return pending;
}

/**
 * Loads `tag` and the languages it falls back on, once, then switches to it.
 * A language absent from the catalog loads nothing and keeps the current one.
 */
export async function loadLocale(tag: Locale): Promise<void> {
  await Promise.all(localeChain(tag, shared().catalog).map(ensureLoaded));
  setLocale(tag);
}

function layers(): LocaleLayer[] {
  const { dictionaries, catalog } = shared();
  const chain: LocaleLayer[] = [];
  for (const tag of localeChain(currentLocale, catalog)) {
    const dictionary = dictionaries.get(tag);
    if (dictionary) chain.push({ tag, dictionary });
  }
  return chain;
}

/** The English text of `key` (the source locale), or `null` when it has none. */
export function sourceText(key: string): string | null {
  const value = lookup(shared().dictionaries.get(SOURCE_LOCALE) ?? {}, key);
  return typeof value === 'string' ? value : null;
}

/** Whether `key` has a message in the current language or one it falls back on. */
export function hasKey(key: string): boolean {
  return translate(layers(), key) !== null;
}

const warned = new Set<string>();

/**
 * The message of `key` in the current language, read key by key down to
 * English; the key itself when nobody has it. A numeric `count` picks the
 * plural form (`key_one`, `key_few`, `key_other`…) by the language's rules.
 */
export function t(key: string, vars?: MessageVars): string {
  const message = translate(layers(), key, vars);
  if (message !== null) return message;
  if (process.env.NODE_ENV === 'development' && !warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] missing key: ${key}`);
  }
  return key;
}
