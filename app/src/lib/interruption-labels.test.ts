import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';
import { INTERRUPTION_LABEL_KEYS, INTERRUPTION_REASONS } from './interruption-labels';

/**
 * `t()` falls back to the English dictionary when a key is missing in the
 * current locale, so calling it can never prove French covers a cause. These
 * tests read the JSON directly.
 *
 * The exhaustiveness of the map itself is enforced by `tsc`
 * (`Record<InterruptionReason, string>`); what is checked here is the other
 * half — that each key it names actually exists, in both locales.
 */
type Dict = Record<string, unknown>;

function has(dict: Dict, key: string): boolean {
  const found = key
    .split('.')
    .reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Dict)[part] : undefined), dict);
  return typeof found === 'string';
}

test('every interruption cause has a label in both locales', () => {
  assert.equal(Object.keys(INTERRUPTION_LABEL_KEYS).length, INTERRUPTION_REASONS.length);
  for (const reason of INTERRUPTION_REASONS) {
    const key = INTERRUPTION_LABEL_KEYS[reason];
    assert.equal(has(en as Dict, key), true, `missing in en: ${key} (${reason})`);
    assert.equal(has(fr as Dict, key), true, `missing in fr: ${key} (${reason})`);
  }
  // The generic label the page falls back on for an unknown value must not
  // disappear either — it is what a cause added to the daemon and not yet
  // mirrored here would display.
  assert.equal(has(en as Dict, 'kanbanPage.interruptionDefault'), true);
  assert.equal(has(fr as Dict, 'kanbanPage.interruptionDefault'), true);
});

test('`stopped` is not described as a kill', () => {
  // A stopped turn leaves the conversation resumable; calling it a kill in the
  // UI would tell the reader to replay a task that is only waiting on them.
  const label = (en as Dict).kanbanPage as Dict;
  assert.match(String(label.interruptionStopped), /resumable/);
});
