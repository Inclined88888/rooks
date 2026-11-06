/**
 * The export dialog's rules (plugins/agent-import/src/export-state.ts): the
 * selection, the body sent, the file name, the message of a refusal, and the
 * en/fr messages it names. Also the assistant's role list, which must be
 * Timon role ids: a task type (`code`) is refused by the agent facade.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

type State = typeof import('../../../plugins/agent-import/src/export-state.js');
const loaded = await import('../../../plugins/agent-import/src/export-state.js') as State & { default?: State };
const { EXPORT_DIALOG_MAX, EXPORT_ERROR_CODES, exportBody, exportFailureKey, exportFileName, kept, toggled, toggledAll } = loaded.default ?? loaded;
type Assistant = typeof import('../../../plugins/agent-import/src/assistant-state.js');
const assistantLoaded = await import('../../../plugins/agent-import/src/assistant-state.js') as Assistant & { default?: Assistant };
const { IMPORT_ROLES } = assistantLoaded.default ?? assistantLoaded;

const agents = [{ name: 'a', role: 'coder', project: null }, { name: 'b', role: null, project: 'p' }];

test('selection: one by one, all or none, and an agent gone from the list drops out', () => {
  assert.deepEqual(toggled([], 'a'), ['a']);
  assert.deepEqual(toggled(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggledAll(['a'], agents), ['a', 'b']);
  assert.deepEqual(toggledAll(['a', 'b'], agents), []);
  assert.deepEqual(kept(['b', 'gone', 'a'], agents), ['a', 'b']);
});

test('the body: nothing to send without a choice or past the ceiling', () => {
  assert.equal(exportBody([]), null);
  assert.deepEqual(exportBody(['a']), { agents: ['a'] });
  assert.equal(exportBody(Array.from({ length: EXPORT_DIALOG_MAX + 1 }, (_, i) => `a${i}`)), null);
});

test('file name and refusals', () => {
  assert.equal(exportFileName(new Date(2026, 10, 3, 9, 5, 7)), 'timon-agents-20261103-090507.zip');
  assert.equal(exportFailureKey(403, { code: 'forbidden' }), 'export.errors.forbidden');
  assert.equal(exportFailureKey(404, { code: 'not_found' }), 'export.errors.not_found');
  assert.equal(exportFailureKey(404, null), 'export.errors.unavailable', 'a 404 without a code: the plugin is not there');
  assert.equal(exportFailureKey(401, null), 'export.errors.unauthorized');
  assert.equal(exportFailureKey(500, { code: 'internal' }), 'export.errors.network');
});

test('every message the dialog and the assistant name exists in English and French', () => {
  const messages = JSON.parse(readFileSync(new URL('../../../plugins/agent-import/src/messages.json', import.meta.url), 'utf8')) as Record<'en' | 'fr', Record<string, string>>;
  const keys = [
    ...EXPORT_ERROR_CODES.map((c) => `export.errors.${c}`), 'export.errors.unavailable', 'export.errors.network',
    'export.open', 'export.title', 'export.description', 'export.loading', 'export.empty', 'export.all', 'export.secrets',
    'export.tooMany', 'export.run', 'export.running', 'export.done', 'agent.cwdSuggested', 'agent.cwdUse',
    ...IMPORT_ROLES.map((r) => `role.${r}`),
  ];
  for (const key of keys) {
    assert.ok(messages.en[key], `en: ${key}`);
    assert.ok(messages.fr[key], `fr: ${key}`);
  }
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.fr).sort());
});

test('the assistant offers Timon role ids, never task types', () => {
  assert.deepEqual([...IMPORT_ROLES], ['research', 'coder', 'reviewer', 'merger', 'librarian', 'ops']);
});
