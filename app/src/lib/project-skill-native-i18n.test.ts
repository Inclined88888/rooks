import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocale, t } from './i18n';
import './i18n-test-locales';

// TODO #625: a project's .claude/skills is read by Claude Code alone. A label
// promising every agent the skill sent Codex users looking for a skill their
// agent never sees.
const KEYS = [
  'chatPage.skillAlreadyNative',
  'chatPage.availableNatively',
  'editPage.skillSectionProjectHint',
  'editPage.skillNativeOnly',
  'skillsPage.sectionProjectHint',
];

test('project skill labels say only a Claude Code agent loads them natively (#625)', () => {
  for (const locale of ['en', 'fr'] as const) {
    setLocale(locale);
    for (const key of KEYS) {
      const text = t(key);
      assert.notEqual(text, key, `${locale}: ${key} is missing`);
      assert.match(text, /Claude Code/, `${locale}: ${key} must name the only backend that loads it`);
      assert.match(text, /only|seulement/, `${locale}: ${key} must not read as true for every backend`);
    }
  }
  setLocale('en');
});
