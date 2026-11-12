#!/usr/bin/env node
// french-ok-file: the pseudo-locale maps ASCII letters to accented look-alikes; it is not French
/**
 * Builds the interface languages from their sources (docs/I18N.md).
 *
 *   node scripts/build-locales.mjs            # what `prebuild`, `pretest`, `pretypecheck` run
 *   node scripts/build-locales.mjs --pseudo   # + the `en-XA` pseudo-locale (`predev` only)
 *
 * Sources: `src/locales/<tag>/` — a language exists when its folder holds a
 * `meta.json`; every other `*.json` of the folder is a namespace, merged at
 * the root of the language's dictionary (`desktop.json` belongs to the
 * desktop shell and stays out). No list of languages lives in the code.
 *
 * Output, all generated, none versioned:
 *  - `public/locales/<tag>.json`: the merged dictionary, fetched by the
 *    browser at `/locales/<tag>.json?v=<hash>` and read from disk by the server;
 *  - `public/locales/manifest.json`: `[{tag,name,dir,coverage,hash,default,fallback}]`;
 *  - `src/locales/.generated/en.ts`: imports every English namespace — English
 *    ships in the bundle because `t()` is synchronous;
 *  - `src/locales/.generated/catalog.ts`: the manifest, for the code that must
 *    know the languages without a request (negotiation, selector).
 *
 * Coverage is computed against English, never declared: the share of the
 * English messages the language has. It is a report, never a gate: every
 * language present is offered, a missing message reads in English. Messages
 * are ICU MessageFormat (a plural lives inside one message), so a message is
 * one key, whatever it holds.
 *
 * Pure node, no dependency. A file is rewritten only when its content
 * changes, so a dev server or an incremental typecheck is not woken for nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE_LOCALE = 'en';
export const PSEUDO_LOCALE = 'en-XA';
export const LOCALE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** Files of a language folder that are not namespaces of the webview. */
const NOT_NAMESPACES = new Set(['meta.json', 'desktop.json']);

export const DEFAULT_PATHS = {
  sourceDir: join(appDir, 'src', 'locales'),
  publicDir: join(appDir, 'public', 'locales'),
  generatedDir: join(appDir, 'src', 'locales', '.generated'),
};

function isDictionary(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeDictionaries(...dictionaries) {
  const merged = {};
  for (const dictionary of dictionaries) {
    for (const [key, value] of Object.entries(dictionary)) {
      const previous = merged[key];
      merged[key] = isDictionary(previous) && isDictionary(value) ? mergeDictionaries(previous, value) : value;
    }
  }
  return merged;
}

export function lookup(dictionary, key) {
  let node = dictionary;
  for (const part of key.split('.')) {
    if (!isDictionary(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Every string leaf of a dictionary, as dotted keys. */
export function leafKeys(dictionary, prefix = '') {
  const keys = [];
  for (const [key, value] of Object.entries(dictionary)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isDictionary(value)) keys.push(...leafKeys(value, path));
    else keys.push(path);
  }
  return keys;
}

/** Share of the English messages `dictionary` has, 0 to 1. */
export function coverageOf(source, dictionary) {
  const keys = leafKeys(source);
  if (keys.length === 0) return 1;
  return keys.filter((key) => typeof lookup(dictionary, key) === 'string').length / keys.length;
}

/** The canonical form of a tag, or `null` when it is not one. */
export function canonicalTag(value) {
  if (typeof value !== 'string' || !LOCALE_TAG_PATTERN.test(value)) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validates a `meta.json`; returns the problems, empty when it is sound. */
export function metaProblems(meta) {
  if (!isDictionary(meta)) return ['meta.json must be an object'];
  const problems = [];
  if (typeof meta.name !== 'string' || meta.name.trim() === '') problems.push('"name" must be the native name of the language');
  if (meta.dir !== undefined && meta.dir !== 'ltr' && meta.dir !== 'rtl') problems.push('"dir" must be "ltr" or "rtl"');
  if (meta.fallback !== undefined && (!Array.isArray(meta.fallback) || meta.fallback.some((tag) => canonicalTag(tag) === null))) {
    problems.push('"fallback" must be a list of language tags');
  }
  if (meta.default !== undefined && typeof meta.default !== 'boolean') problems.push('"default" must be true or false');
  return problems;
}

/**
 * The languages present under `sourceDir`: one per folder holding a
 * `meta.json`, sorted by tag. A folder whose name is not its canonical tag
 * (`pt-br`), or a broken `meta.json`, stops the build.
 */
export function discoverLocales(sourceDir = DEFAULT_PATHS.sourceDir) {
  const locales = [];
  for (const entry of readdirSync(sourceDir).sort()) {
    const dir = join(sourceDir, entry);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'meta.json'))) continue;
    const tag = canonicalTag(entry);
    if (tag !== entry) throw new Error(`${dir}: a language folder is named by its canonical BCP 47 tag (${tag ?? 'not a tag'})`);
    const meta = readJson(join(dir, 'meta.json'));
    const problems = metaProblems(meta);
    if (problems.length > 0) throw new Error(`${join(dir, 'meta.json')}: ${problems.join('; ')}`);
    locales.push({ tag, dir, meta });
  }
  if (!locales.some((locale) => locale.tag === SOURCE_LOCALE)) throw new Error(`${sourceDir}: no ${SOURCE_LOCALE}/meta.json — English is the source language`);
  return locales;
}

/** The namespace files of a language folder, sorted by name. */
export function namespaceFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !NOT_NAMESPACES.has(name))
    .sort();
}

/** A language's dictionary: its namespaces merged at the root. */
export function readLocaleDictionary(dir) {
  return mergeDictionaries(...namespaceFiles(dir).map((name) => readJson(join(dir, name))));
}

const PSEUDO_LETTERS = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/**
 * One message of the pseudo-locale: accented letters, 40 % longer, between
 * brackets — a string still plain on screen is hard-coded, a cut bracket is
 * an overflow. Only the text is touched: argument names, `plural`/`select`
 * keywords and their options stay ICU, and a quoted part stays as written.
 */
export function pseudoLocalize(text) {
  let out = '';
  const frames = ['text'];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const frame = frames[frames.length - 1];
    if (frame === 'text' && char === "'" && /['{}#|]/.test(text[i + 1] ?? '')) {
      const end = text[i + 1] === "'" ? i + 1 : text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length - 1 : end;
      out += text.slice(i, stop + 1);
      i = stop;
    } else if (char === '{') {
      frames.push(frame === 'text' ? 'argument' : 'text');
      out += char;
    } else if (char === '}') {
      if (frames.length > 1) frames.pop();
      out += char;
    } else {
      out += frame === 'text' ? (PSEUDO_LETTERS[char] ?? char) : char;
    }
  }
  return `[${out}${'·'.repeat(Math.ceil(text.length * 0.4))}]`;
}

function pseudoDictionary(dictionary) {
  const out = {};
  for (const [key, value] of Object.entries(dictionary)) {
    out[key] = isDictionary(value) ? pseudoDictionary(value) : typeof value === 'string' ? pseudoLocalize(value) : value;
  }
  return out;
}

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Everything the build writes, computed without writing: the manifest, the
 * per-language dictionaries and the generated TypeScript modules.
 */
export function buildLocales({ sourceDir = DEFAULT_PATHS.sourceDir, pseudo = false } = {}) {
  const locales = discoverLocales(sourceDir).map((locale) => ({ ...locale, dictionary: readLocaleDictionary(locale.dir) }));
  const source = locales.find((locale) => locale.tag === SOURCE_LOCALE);
  if (pseudo) {
    locales.push({
      tag: PSEUDO_LOCALE,
      dir: null,
      meta: { name: 'Ëñĝļîšĥ (pseudo)', dir: 'ltr' },
      dictionary: pseudoDictionary(source.dictionary),
    });
  }
  const files = new Map();
  const manifest = locales.map((locale) => {
    const text = `${JSON.stringify(locale.dictionary)}\n`;
    files.set(`${locale.tag}.json`, text);
    return {
      tag: locale.tag,
      name: locale.meta.name,
      dir: locale.meta.dir ?? 'ltr',
      coverage: Math.round(coverageOf(source.dictionary, locale.dictionary) * 1000) / 1000,
      hash: hashOf(text),
      ...(locale.meta.default === true ? { default: true } : {}),
      ...(Array.isArray(locale.meta.fallback) && locale.meta.fallback.length > 0
        ? { fallback: locale.meta.fallback.map((tag) => canonicalTag(tag)) }
        : {}),
    };
  });
  files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files, generated: generatedModules(source, manifest) };
}

function generatedModules(source, manifest) {
  const header = '// Generated by app/scripts/build-locales.mjs from src/locales/ — do not edit, do not commit.\n';
  const names = namespaceFiles(source.dir);
  const imports = names.map((name, index) => `import ns${index} from '../${SOURCE_LOCALE}/${name}';`).join('\n');
  const en = `${header}${imports}\n\n/** The English namespaces, in file order; \`i18n.ts\` merges them. */\nexport const EN_NAMESPACES: readonly Record<string, unknown>[] = [${names.map((_, index) => `ns${index}`).join(', ')}];\n`;
  const catalog = `${header}import type { LocaleInfo } from '../../lib/i18n-core';\n\n/** The languages present, as \`public/locales/manifest.json\` lists them. */\nexport const LOCALE_CATALOG: readonly LocaleInfo[] = ${JSON.stringify(manifest, null, 2)};\n`;
  return new Map([['en.ts', en], ['catalog.ts', catalog]]);
}

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/** Builds and writes; stale `<tag>.json` of a removed language are deleted. */
export function writeLocales({ sourceDir, publicDir = DEFAULT_PATHS.publicDir, generatedDir = DEFAULT_PATHS.generatedDir, pseudo = false } = {}) {
  const { manifest, files, generated } = buildLocales({ sourceDir, pseudo });
  let written = 0;
  for (const [name, content] of files) if (writeIfChanged(join(publicDir, name), content)) written += 1;
  for (const [name, content] of generated) if (writeIfChanged(join(generatedDir, name), content)) written += 1;
  for (const name of readdirSync(publicDir)) {
    if (name.endsWith('.json') && !files.has(name)) rmSync(join(publicDir, name));
  }
  return { manifest, written };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { manifest, written } = writeLocales({ pseudo: process.argv.includes('--pseudo') });
    const summary = manifest.map((entry) => `${entry.tag} ${Math.round(entry.coverage * 100)}%`).join(', ');
    console.log(`[build-locales] ${manifest.length} language(s): ${summary}${written ? ` — ${written} file(s) written` : ''}`);
  } catch (error) {
    console.error(`[build-locales] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
