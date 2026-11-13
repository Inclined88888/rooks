/**
 * The shell's own words (menus, tray, dialogs, local pages) in the language
 * the user picked in the app (docs/I18N.md, Electron shell section).
 *
 * The messages live with the app's: `<tag>/desktop.json` beside each
 * language's `meta.json` under `app/src/locales`, read from there when the
 * shell runs from the sources, from `resources/locales` in a package (copied
 * by `prepare:deps`, see `scripts/shell-locales.mjs`). A language exists when
 * its folder has a `meta.json`, as in the webview; one without `desktop.json`
 * reads every shell message in English, key by key like any missing message.
 *
 * Plurals, negotiation and fallbacks come from `i18n-core.ts`, the very file
 * the webview uses (a test holds the copy identical).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_LOCALE, canonicalTag, isDictionary, localeChain, negotiate, translate,
  type Dictionary, type LocaleInfo, type LocaleLayer, type MessageVars, type TextDirection,
} from './i18n-core.js';

export const SHELL_MESSAGES_FILE = 'desktop.json';
export const LOCALE_META_FILE = 'meta.json';
/** Every shell key lives under this one, so `desktop.json` never collides with a web namespace. */
const NAMESPACE = 'desktop';

/** Packaged: `resources/locales` (electron-builder.yml). From the sources: the app's own folders. */
export function shellLocalesDir(input: { packaged: boolean; resourcesPath: string; desktopRoot: string }): string {
  return input.packaged ? join(input.resourcesPath, 'locales') : join(input.desktopRoot, '..', 'app', 'src', 'locales');
}

/** `desktop/src` (tests) and `desktop/dist` (a shell run from the sources) both sit two levels under the repository. */
const SOURCE_DIR = fileURLToPath(new URL('../../app/src/locales', import.meta.url));

export interface ShellLanguage {
  readonly info: LocaleInfo;
  readonly dictionary: Dictionary;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * The languages under `dir`, by tag. A folder whose name is not a canonical
 * tag, whose `meta.json` is broken or whose `desktop.json` does not parse is
 * skipped with a warning: the shell must open whatever a contributor broke.
 */
export function readShellLanguages(dir: string, warn: (message: string) => void = console.warn): Map<string, ShellLanguage> {
  const languages = new Map<string, ShellLanguage>();
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    warn(`[i18n] no shell languages in ${dir}: the shell speaks its keys`);
    return languages;
  }
  for (const name of entries) {
    const meta = join(dir, name, LOCALE_META_FILE);
    if (canonicalTag(name) !== name || !existsSync(meta)) continue;
    try {
      const parsed = readJson(meta);
      if (!isDictionary(parsed)) throw new Error('not an object');
      const messages = join(dir, name, SHELL_MESSAGES_FILE);
      const dictionary = existsSync(messages) ? readJson(messages) : {};
      if (!isDictionary(dictionary)) throw new Error(`${SHELL_MESSAGES_FILE} is not an object`);
      const fallback = Array.isArray(parsed.fallback) ? parsed.fallback.filter((tag): tag is string => typeof tag === 'string') : undefined;
      languages.set(name, {
        info: {
          tag: name,
          name: typeof parsed.name === 'string' ? parsed.name : name,
          dir: parsed.dir === 'rtl' ? 'rtl' : 'ltr',
          coverage: 0,
          hash: '',
          ...(parsed.default === true ? { default: true } : {}),
          ...(fallback?.length ? { fallback } : {}),
        },
        dictionary,
      });
    } catch (error) {
      warn(`[i18n] shell language ${name} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return languages;
}

let localesDir = SOURCE_DIR;
let loaded: Map<string, ShellLanguage> | null = null;
const translators = new Map<string, ShellTranslator>();

/** Where the shell reads its languages; the main process points a package at `resources/locales`. */
export function useShellLocales(dir: string): void {
  localesDir = dir;
  loaded = null;
  translators.clear();
}

function languages(): Map<string, ShellLanguage> {
  loaded ??= readShellLanguages(localesDir);
  return loaded;
}

/** The languages present, as the language selector of the app lists them. */
export function shellCatalog(): LocaleInfo[] {
  return [...languages().values()].map((language) => language.info);
}

/** The language present that best answers `requested` (cookie tag, then the OS's languages), English otherwise. */
export function resolveShellLocale(requested: readonly string[]): string {
  return negotiate(requested, shellCatalog()) ?? SOURCE_LOCALE;
}

export type ShellTranslator = ((key: string, vars?: MessageVars) => string) & {
  /** The language resolved for the reader: `<html lang>`, `Intl` formats. */
  readonly tag: string;
  readonly dir: TextDirection;
};

/**
 * The translator of a reader who asked for `locale` (any tag: `fr`,
 * `fr-CA`, `pt-PT`, an OS locale): negotiated among the languages present,
 * read key by key along `[tag, meta.fallback…, en]`. A key absent everywhere
 * reads as itself, so a missing message shows rather than an empty button.
 */
export function shellText(locale: string | null | undefined): ShellTranslator {
  const asked = locale ?? '';
  const cached = translators.get(asked);
  if (cached) return cached;
  const all = languages();
  const tag = resolveShellLocale(asked ? [asked] : []);
  const chain: LocaleLayer[] = localeChain(tag, shellCatalog())
    .map((next) => all.get(next))
    .filter((language): language is ShellLanguage => language !== undefined)
    .map((language) => ({ tag: language.info.tag, dictionary: language.dictionary }));
  const translator = Object.assign(
    (key: string, vars?: MessageVars): string => translate(chain, `${NAMESPACE}.${key}`, vars) ?? key,
    { tag, dir: all.get(tag)?.info.dir ?? 'ltr' },
  );
  translators.set(asked, translator);
  return translator;
}
