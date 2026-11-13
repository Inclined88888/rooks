/**
 * The generic parity test: it replaces the screen-by-screen `*-i18n` tests.
 *
 * It reads the sources through the lint, `scripts/check-locales.mjs`: every
 * message of every language parses as ICU MessageFormat and names the same
 * arguments as English. Only English is required whole; a message missing
 * elsewhere reads in English, and shows in the coverage report.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { leafKeys, lookup, readLocaleDictionary, DEFAULT_PATHS } from '../../scripts/build-locales.mjs';
import { checkLocales } from '../../scripts/check-locales.mjs';
import { translate } from './i18n-core';

test('every message of every language parses as ICU and names the arguments of English', () => {
  const { errors, report } = checkLocales();
  assert.deepEqual(errors, []);
  assert.equal(report.find((entry) => entry.tag === 'en')?.coverage, 1);
});

/**
 * The move to ICU must not change what a reader saw: every English and
 * French message with plain `{name}` arguments renders, under ICU, what the
 * former `{name}` replacement rendered. A message that quotes (`'{'`, `''`)
 * was escaped on purpose; core tests cover the quoting rules.
 */
test('ICU renders every existing message as the former {name} interpolation did', () => {
  for (const tag of ['en', 'fr']) {
    const dictionary = readLocaleDictionary(join(DEFAULT_PATHS.sourceDir, tag));
    const layer = { tag, dictionary };
    for (const key of leafKeys(dictionary)) {
      const message = lookup(dictionary, key);
      if (typeof message !== 'string' || /'[{}']|\{\w+,/.test(message)) continue;
      const vars = Object.fromEntries([...message.matchAll(/\{(\w+)\}/g)].map((match) => [match[1] ?? '', `<${match[1]}>`]));
      const former = message.replace(/\{(\w+)\}/g, (_, name: string) => `<${name}>`);
      assert.equal(translate([layer], key, vars), former, `${tag}: ${key}`);
    }
  }
});

function write(root: string, path: string, value: unknown): void {
  const file = join(root, ...path.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function fixture(languages: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'locales-lint-'));
  write(root, 'en/meta.json', { name: 'English' });
  write(root, 'en/core.json', {
    greet: 'Hello {name}',
    files: { selected: '{count, plural, one {# file} other {# files}}' },
  });
  for (const [tag, dictionary] of Object.entries(languages)) {
    write(root, `${tag}/meta.json`, { name: tag });
    write(root, `${tag}/core.json`, dictionary);
  }
  return root;
}

test('a language may lag behind English: a missing message is only a lower coverage', () => {
  const { errors, warnings, report } = checkLocales({ sourceDir: fixture({ fr: { greet: 'Bonjour {name}' } }) });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(report.find((entry) => entry.tag === 'fr'), { tag: 'fr', coverage: 0.5 });
});

test('arguments must match English; a plural branch may leave out #', () => {
  const root = fixture({
    fr: { greet: 'Bonjour {nom}', files: { selected: '{count, plural, one {un fichier} other {# fichiers}}' } },
  });
  assert.deepEqual(checkLocales({ sourceDir: root }).errors, ['fr: greet: arguments nom, English has name']);
});

test('plurals: Polish categories pass, a category the language lacks and a missing other fail', () => {
  const root = fixture({
    pl: { files: { selected: '{count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}' } },
    de: { files: { selected: '{count, plural, one {# Datei} few {# x} other {# Dateien}}' } },
    ja: { files: { selected: '{count, plural, one {#}}' } },
  });
  const { errors } = checkLocales({ sourceDir: root });
  assert.equal(errors.some((line) => line.startsWith('pl:')), false, errors.join('\n'));
  assert.ok(errors.some((line) => line.startsWith('de: files.selected: "few" is not a cardinal plural category of de')), errors.join('\n'));
  assert.ok(errors.some((line) => line.startsWith('ja: files.selected: not valid ICU MessageFormat (MISSING_OTHER_CLAUSE')), errors.join('\n'));
});

test('an unquoted literal brace is an error; an orphan key only warns', () => {
  const root = fixture({ fr: { greet: 'Bonjour {name}, voir {{vars.x}}', stray: 'x' } });
  const { errors, warnings } = checkLocales({ sourceDir: root });
  assert.match(errors.join('\n'), /fr: greet: not valid ICU MessageFormat/);
  assert.deepEqual(warnings, ['fr: stray: unknown key, English has no such message']);
});

test('the desktop shell\'s desktop.json gets the same checks against English\'s own', () => {
  const root = fixture({ fr: { greet: 'Bonjour {name}' } });
  write(root, 'en/desktop.json', { desktop: { menu: { open: 'Open {appName}', quit: 'Quit' } } });
  write(root, 'fr/desktop.json', { desktop: { menu: { open: 'Ouvrir {app}' } } });
  const { errors, shellReport } = checkLocales({ sourceDir: root });
  assert.deepEqual(errors, ['desktop.json: fr: desktop.menu.open: arguments app, English has appName']);
  assert.deepEqual(shellReport.find((entry) => entry.tag === 'fr'), { tag: 'fr', coverage: 0.5 });
  writeFileSync(join(root, 'fr', 'desktop.json'), '{');
  assert.match(checkLocales({ sourceDir: root }).errors.join('\n'), /fr\/desktop\.json: invalid JSON/);
});

test('invalid JSON and a broken folder are errors whatever the language', () => {
  const root = fixture({});
  mkdirSync(join(root, 'de'));
  writeFileSync(join(root, 'de', 'meta.json'), JSON.stringify({ name: 'Deutsch' }));
  writeFileSync(join(root, 'de', 'core.json'), '{ "greet": ');
  assert.match(checkLocales({ sourceDir: root }).errors.join('\n'), /de\/core\.json: invalid JSON/);
  write(root, 'DE-at/meta.json', { name: 'x' });
  assert.match(checkLocales({ sourceDir: root }).errors.join('\n'), /canonical BCP 47 tag \(de-AT\)/);
});
