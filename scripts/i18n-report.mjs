#!/usr/bin/env node
/**
 * How far each interface language is translated (docs/I18N.md,
 * CONTRIBUTING-TRANSLATIONS.md):
 *
 *   node scripts/i18n-report.mjs                 # coverage of every language
 *   node scripts/i18n-report.mjs --missing de    # + the English messages German lacks, file by file
 *   node scripts/i18n-report.mjs --unused        # + English messages no code seems to read
 *   node scripts/i18n-report.mjs --json          # the same, for a tool
 *
 * A report, never a gate: only English must be whole, a message another
 * language lacks reads in English. The checks that do fail (ICU syntax,
 * arguments, plural categories) are `cd app && node scripts/check-locales.mjs`.
 *
 * Coverage counts the messages of the webview and, apart, those of the desktop
 * shell (`desktop.json`), against English. "Unused" is a guess read from the
 * code (`app/scripts/i18n-usage.mjs`): a key assembled in a way the scan does
 * not follow shows up too, so check before deleting.
 *
 * Pure node, no dependency: it runs from the repository root, before any
 * `npm install`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PATHS, SOURCE_LOCALE, discoverLocales, leafKeys, lookup, namespaceFiles, readLocaleDictionary,
} from '../app/scripts/build-locales.mjs';
import { DEFAULT_CODE_DIR, codeFiles, probablyUnused, scanUsage } from '../app/scripts/i18n-usage.mjs';

const DESKTOP_FILE = 'desktop.json';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function present(dictionary, key) {
  return typeof lookup(dictionary, key) === 'string';
}

function ratio(have, total) {
  return total === 0 ? 1 : have / total;
}

/**
 * The report of every language under `sourceDir`. Per language: its name,
 * the webview coverage (`have`/`total`), the desktop shell's when English has
 * one, and the English messages it lacks, grouped by the English file holding
 * them. `unused` (English keys no code seems to read) when `codeDir` is given.
 */
export function buildReport({ sourceDir = DEFAULT_PATHS.sourceDir, codeDir } = {}) {
  const locales = discoverLocales(sourceDir);
  const source = locales.find((locale) => locale.tag === SOURCE_LOCALE);
  if (!source) throw new Error(`no ${SOURCE_LOCALE}/ folder under ${sourceDir}`);
  const englishFiles = namespaceFiles(source.dir).map((file) => ({ file, keys: leafKeys(readJson(join(source.dir, file))) }));
  const englishDesktop = existsSync(join(source.dir, DESKTOP_FILE)) ? leafKeys(readJson(join(source.dir, DESKTOP_FILE))) : null;
  const total = englishFiles.reduce((sum, entry) => sum + entry.keys.length, 0);

  const languages = locales.map((locale) => {
    const dictionary = readLocaleDictionary(locale.dir);
    const missing = {};
    let have = 0;
    for (const { file, keys } of englishFiles) {
      const lacking = keys.filter((key) => !present(dictionary, key));
      have += keys.length - lacking.length;
      if (lacking.length > 0) missing[file] = lacking;
    }
    let desktop = null;
    if (englishDesktop) {
      const path = join(locale.dir, DESKTOP_FILE);
      const shell = existsSync(path) ? readJson(path) : {};
      const lacking = englishDesktop.filter((key) => !present(shell, key));
      desktop = { have: englishDesktop.length - lacking.length, total: englishDesktop.length };
      if (lacking.length > 0) missing[DESKTOP_FILE] = lacking;
    }
    return { tag: locale.tag, name: locale.meta.name, have, total, coverage: ratio(have, total), desktop, missing };
  });
  languages.sort((a, b) => (a.tag === SOURCE_LOCALE ? -1 : b.tag === SOURCE_LOCALE ? 1 : a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const report = { languages };
  if (codeDir) {
    const keys = englishFiles.flatMap((entry) => entry.keys);
    report.unused = probablyUnused(keys, scanUsage(codeFiles(codeDir), { root: codeDir })).sort();
  }
  return report;
}

function percent(value) {
  const shown = Math.floor(value * 1000) / 10;
  return `${shown % 1 === 0 ? shown.toFixed(0) : shown.toFixed(1)} %`;
}

/** The report as text, for a terminal. `missingFor`: tags whose gaps are listed. */
export function formatReport(report, { missingFor = [] } = {}) {
  const lines = [];
  const width = Math.max(...report.languages.map((language) => `${language.tag} ${language.name}`.length), 8);
  for (const language of report.languages) {
    const label = `${language.tag} ${language.name}`.padEnd(width);
    const desktop = language.desktop ? `   desktop ${percent(ratio(language.desktop.have, language.desktop.total)).padStart(7)}` : '';
    lines.push(`${label}  ${percent(language.coverage).padStart(7)}  ${String(language.have).padStart(5)}/${language.total}${desktop}`);
  }
  for (const tag of missingFor) {
    const language = report.languages.find((entry) => entry.tag.toLowerCase() === tag.toLowerCase());
    if (!language) {
      lines.push('', `${tag}: no such language (app/src/locales/${tag}/meta.json)`);
      continue;
    }
    const files = Object.entries(language.missing);
    lines.push('', files.length === 0 ? `${language.tag}: nothing missing` : `${language.tag}: missing, by English file`);
    for (const [file, keys] of files) {
      lines.push(`  ${file} (${keys.length})`);
      for (const key of keys) lines.push(`    ${key}`);
    }
  }
  if (report.unused) {
    lines.push('', `English messages no code seems to read: ${report.unused.length} (a guess — check before deleting)`);
    for (const key of report.unused) lines.push(`  ${key}`);
  }
  return lines.join('\n');
}

/** `--missing <tag>` (repeatable), `--unused`, `--json`. */
export function parseArgs(argv) {
  const options = { missingFor: [], unused: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--unused') options.unused = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--missing') {
      const tag = argv[i + 1];
      if (!tag || tag.startsWith('--')) throw new Error('--missing needs a language tag, e.g. --missing de');
      options.missingFor.push(tag);
      i += 1;
    } else throw new Error(`unknown option ${arg} (--missing <tag>, --unused, --json)`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const report = buildReport({ codeDir: options.unused ? DEFAULT_CODE_DIR : undefined });
  if (options.json) {
    if (options.missingFor.length === 0) for (const language of report.languages) delete language.missing;
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, options));
  }
}
