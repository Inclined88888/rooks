/**
 * Dates and numbers format in the interface language only if every module
 * goes through `intl.ts` (docs/I18N.md). A `toLocaleString()` takes the
 * browser's language, a `new Intl.DateTimeFormat('fr-FR')` or a
 * `=== 'fr' ? 'fr-FR'` branch ignores every other language present: this
 * guard refuses them anywhere else in `src/`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

const SRC = join(process.cwd(), 'src');

/** Files allowed to build `Intl` objects themselves, each with its reason. */
const ALLOWED: Readonly<Record<string, string>> = {
  'lib/intl.ts': 'the helper itself',
  'lib/i18n-core.ts': 'language negotiation compares scripts with Intl.Locale; copied byte for byte into desktop/',
  'lib/stream-presentation.ts': 'grapheme segmentation of streamed text, independent of the language',
  'plugins-client/local-dictation/model-view.ts': 'a bundled plugin held to the public surface: @timon/ui has no language-name formatter',
};

const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'toLocale*String()', pattern: /\.toLocale(?:Date|Time)?String\(/ },
  { name: 'new Intl.*', pattern: /\bnew Intl\.[A-Z]/ },
  { name: 'Intl.* called without new', pattern: /(?<!new )\bIntl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|Collator|DisplayNames|PluralRules)\(/ },
  { name: "a 'fr' ? 'fr-FR' branch", pattern: /'fr'\s*\?\s*'[a-z]{2}-[A-Z]{2}'/ },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('dates and numbers format through intl.ts only', () => {
  const offences: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel in ALLOWED) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const { name, pattern } of RULES) {
        if (pattern.test(line)) offences.push(`${rel}:${i + 1} — ${name}`);
      }
    });
  }
  assert.deepEqual(offences, [], 'format through `@/lib/intl` (formatDate, formatNumber, formatRelativeTime…)');
});

test('the guard bites', () => {
  const samples = [
    "new Date(ms).toLocaleString()",
    "n.toLocaleString()",
    "new Intl.DateTimeFormat('fr-FR', {})",
    "Intl.NumberFormat(locale).format(1)",
    "getLocale() === 'fr' ? 'fr-FR' : 'en-US'",
  ];
  for (const sample of samples) {
    assert.ok(RULES.some(({ pattern }) => pattern.test(sample)), sample);
  }
  assert.ok(!RULES.some(({ pattern }) => pattern.test('name.toLocaleUpperCase(tag)')));
});
