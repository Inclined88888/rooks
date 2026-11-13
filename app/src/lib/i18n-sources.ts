/**
 * The languages read straight from their sources (`src/locales/<tag>/`),
 * for the tests and the tooling — never for the app, which reads what
 * `scripts/build-locales.mjs` generated. Node only.
 *
 * The tests read the sources rather than `public/locales/`: that folder is
 * generated, and a test must see the translation as it is written now.
 */
import { buildLocales, DEFAULT_PATHS } from '../../scripts/build-locales.mjs';
import { registerLocale, setLocaleCatalog, setLocaleLoader, type Dictionary, type LocaleInfo } from './i18n';

function build(sourceDir: string): { manifest: LocaleInfo[]; dictionaries: Map<string, Dictionary> } {
  const { manifest, files } = buildLocales({ sourceDir });
  const dictionaries = new Map<string, Dictionary>();
  for (const info of manifest) dictionaries.set(info.tag, JSON.parse(files.get(`${info.tag}.json`) ?? '{}') as Dictionary);
  return { manifest, dictionaries };
}

/**
 * Catalog and loader from the sources; nothing loaded yet, `loadLocale`
 * does it, as the browser's fetch would.
 */
export function useSourceLocaleLoader(sourceDir: string = DEFAULT_PATHS.sourceDir): readonly LocaleInfo[] {
  const { manifest, dictionaries } = build(sourceDir);
  setLocaleCatalog(manifest);
  setLocaleLoader(async (info) => dictionaries.get(info.tag) ?? {});
  return manifest;
}

/** Catalog from the sources and every language registered at once: `setLocale` works synchronously. */
export function useSourceLocales(sourceDir: string = DEFAULT_PATHS.sourceDir): readonly LocaleInfo[] {
  const { manifest, dictionaries } = build(sourceDir);
  setLocaleCatalog(manifest);
  for (const [tag, dictionary] of dictionaries) registerLocale(tag, dictionary);
  setLocaleLoader(async (info) => dictionaries.get(info.tag) ?? {});
  return manifest;
}
