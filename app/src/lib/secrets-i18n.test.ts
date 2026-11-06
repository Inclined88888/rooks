import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import en from '../locales/en/core.json';
import {
  BROKER_ERROR_KEYS,
  BROKER_PRESET_HINT_KEYS,
  BROKER_PRESET_LABEL_KEYS,
  CONFIGURED_LABEL_KEYS,
  MODE_HINT_KEYS,
  MODE_LABEL_KEYS,
  SCOPE_CHOICE_LABEL_KEYS,
  SCOPE_KIND_LABEL_KEYS,
} from './secrets';

/**
 * Every key the page uses exists in English, read from the JSON: `t()`
 * returns the key itself when nobody has it. Only English is required whole;
 * another language that lacks a key reads it in English (docs/I18N.md).
 */

type Dict = Record<string, unknown>;

function has(dict: Dict, key: string): boolean {
  const found = key
    .split('.')
    .reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Dict)[part] : undefined), dict);
  return typeof found === 'string';
}

const SOURCES = [
  new URL('../plugins-client/secrets-vault/secrets-page.tsx', import.meta.url),
  new URL('../plugins-client/secrets-vault/page.tsx', import.meta.url),
  new URL('../plugins-client/secrets-vault/plugin-grant-dialog.tsx', import.meta.url),
];

test('the navigation names the secrets page', () => {
  assert.equal(has(en as Dict, 'nav.secrets'), true);
});

test('keys built by template resolve in English', () => {
  const templated = [
    ...Object.values(SCOPE_KIND_LABEL_KEYS),
    ...Object.values(SCOPE_CHOICE_LABEL_KEYS),
    ...Object.values(MODE_LABEL_KEYS),
    ...Object.values(MODE_HINT_KEYS),
    ...Object.values(CONFIGURED_LABEL_KEYS),
    ...Object.values(BROKER_PRESET_LABEL_KEYS),
    ...Object.values(BROKER_PRESET_HINT_KEYS),
    ...BROKER_ERROR_KEYS,
  ];
  for (const key of templated) {
    assert.equal(has(en as Dict, key), true, `missing in en: ${key}`);
  }
});

test('every literal key used by the page exists in English', () => {
  // Any quoted key from a dictionary the page draws on, not only the ones
  // directly after `t(`: several are picked by a ternary inside the call.
  const used = new Set<string>();
  for (const url of SOURCES) {
    const source = readFileSync(url, 'utf8');
    for (const m of source.matchAll(/'((?:secretsPage|common|nav)\.[\w.]+)'/g)) {
      if (m[1]) used.add(m[1]);
    }
  }
  assert.ok(used.size > 10, 'no i18n call found — did the page move?');
  for (const key of used) {
    assert.equal(has(en as Dict, key), true, `missing in en: ${key}`);
  }
});
