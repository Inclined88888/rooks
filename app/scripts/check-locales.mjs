#!/usr/bin/env node
/**
 * Lints the interface languages (docs/I18N.md):
 *
 *   node scripts/check-locales.mjs
 *
 * Errors, in every language — what would show a broken string on screen:
 * invalid JSON, a broken `meta.json` or a folder not named by its canonical
 * tag, a message that is not a string, a message that does not parse as ICU
 * MessageFormat, a message whose arguments differ from the English one, a
 * plural option the language does not have (`few` in English).
 *
 * Warnings: a key English does not have (an orphan nobody reads).
 *
 * Report: the coverage of each language. Only English is required whole;
 * every other language may lag behind, a missing message reads in English.
 *
 * `desktop.json` (the desktop shell's menus and dialogs) gets the same
 * checks, against English's own `desktop.json`, with its own coverage.
 *
 * The generic parity test (`src/lib/locale-parity.test.ts`) runs the same
 * check. Node only, one dependency: `intl-messageformat`, the parser the
 * interface itself uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntlMessageFormat } from 'intl-messageformat';

import {
  DEFAULT_PATHS, SOURCE_LOCALE, coverageOf, discoverLocales, leafKeys, lookup, mergeDictionaries, namespaceFiles,
} from './build-locales.mjs';

/** The desktop shell's messages, one per language folder, kept out of the web dictionary. */
const SHELL_FILE = 'desktop.json';

/**
 * Walks an ICU syntax tree: argument names, and the plural options used
 * with their kind (`cardinal` / `ordinal`). Read structurally, like
 * `src/lib/i18n-core.ts` does.
 */
function walk(nodes, found = { args: new Set(), plurals: [] }) {
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    // 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural.
    if (typeof node.type === 'number' && node.type >= 1 && node.type <= 6 && typeof node.value === 'string') found.args.add(node.value);
    if (node.type === 6 && node.options) found.plurals.push({ kind: node.pluralType === 'ordinal' ? 'ordinal' : 'cardinal', options: Object.keys(node.options) });
    if (node.options) for (const option of Object.values(node.options)) if (Array.isArray(option?.value)) walk(option.value, found);
    if (Array.isArray(node.children)) walk(node.children, found);
  }
  return found;
}

/** Arguments and plural options of a message; throws when it does not parse. */
export function parseMessage(message, tag) {
  return walk(new IntlMessageFormat(message, tag, undefined, { ignoreTag: true }).getAst());
}

function show(names) {
  return names.size === 0 ? 'none' : [...names].sort().join(', ');
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function readNamespaces(dir, errors, tag) {
  const dictionaries = [];
  for (const name of namespaceFiles(dir)) {
    try {
      dictionaries.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    } catch (error) {
      errors.push(`${tag}/${name}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return mergeDictionaries(...dictionaries);
}

/**
 * Checks every language under `sourceDir`. Returns the errors (blocking),
 * the warnings and the coverage of each language.
 */
export function checkLocales({ sourceDir = DEFAULT_PATHS.sourceDir } = {}) {
  const errors = [];
  const warnings = [];
  let locales;
  try {
    locales = discoverLocales(sourceDir);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], warnings, report: [] };
  }
  const read = locales.map((locale) => ({ tag: locale.tag, dictionary: readNamespaces(locale.dir, errors, locale.tag) }));
  const report = checkDictionaries(read, errors, warnings, '');
  // The desktop shell's words: same rules, measured against English's own desktop.json.
  const shell = locales
    .map((locale) => ({ tag: locale.tag, dictionary: readShellMessages(locale.dir, errors, locale.tag) }))
    .filter((locale) => locale.dictionary !== null);
  const shellReport = checkDictionaries(shell, errors, warnings, `${SHELL_FILE}: `);
  return { errors, warnings, report, shellReport };
}

/** A language's `desktop.json`, or `null` when it has none (the shell then reads English). */
function readShellMessages(dir, errors, tag) {
  const file = join(dir, SHELL_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${tag}/${SHELL_FILE}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Checks one set of dictionaries against its English member; returns the coverage of each language. */
function checkDictionaries(read, errors, warnings, label) {
  // English first: every other language is measured against its arguments.
  read.sort((a, b) => Number(b.tag === SOURCE_LOCALE) - Number(a.tag === SOURCE_LOCALE));
  const sourceArgs = new Map();
  const report = [];
  for (const { tag, dictionary } of read) {
    const categories = {
      cardinal: new Set(new Intl.PluralRules(tag).resolvedOptions().pluralCategories),
      ordinal: new Set(new Intl.PluralRules(tag, { type: 'ordinal' }).resolvedOptions().pluralCategories),
    };
    for (const key of leafKeys(dictionary)) {
      const message = lookup(dictionary, key);
      if (typeof message !== 'string') {
        errors.push(`${label}${tag}: ${key}: a message is a string, not ${Array.isArray(message) ? 'a list' : typeof message}`);
        continue;
      }
      let parsed;
      try {
        parsed = parseMessage(message, tag);
      } catch (error) {
        errors.push(`${label}${tag}: ${key}: not valid ICU MessageFormat (${error instanceof Error ? error.message : String(error)}) — quote literal braces: '{'…'}'`);
        continue;
      }
      for (const plural of parsed.plurals) {
        for (const option of plural.options) {
          if (option.startsWith('=') || categories[plural.kind].has(option)) continue;
          errors.push(`${label}${tag}: ${key}: "${option}" is not a ${plural.kind} plural category of ${tag} (${[...categories[plural.kind]].join(', ')})`);
        }
      }
      if (tag === SOURCE_LOCALE) {
        sourceArgs.set(key, parsed.args);
        continue;
      }
      const expected = sourceArgs.get(key);
      if (!expected) {
        warnings.push(`${label}${tag}: ${key}: unknown key, English has no such message`);
        continue;
      }
      if (!sameSet(expected, parsed.args)) errors.push(`${label}${tag}: ${key}: arguments ${show(parsed.args)}, English has ${show(expected)}`);
    }
    const source = read.find((locale) => locale.tag === SOURCE_LOCALE)?.dictionary ?? {};
    report.push({ tag, coverage: coverageOf(source, dictionary) });
  }
  report.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, warnings, report, shellReport } = checkLocales();
  for (const line of warnings) console.warn(`warning  ${line}`);
  for (const line of errors) console.error(`error    ${line}`);
  const percent = (coverage) => `${String(Math.round(coverage * 1000) / 10).padStart(5)}%`;
  for (const entry of report) {
    const shell = shellReport.find((item) => item.tag === entry.tag);
    console.log(`${entry.tag.padEnd(8)} ${percent(entry.coverage)}   desktop ${shell ? percent(shell.coverage) : '    0%'}`);
  }
  console.log(`[check-locales] ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}
