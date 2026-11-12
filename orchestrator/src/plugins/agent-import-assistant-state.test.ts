/**
 * The import assistant's rules (plugins/agent-import/src/assistant-state.ts),
 * on a preview typed like the engine's: the choices drawn from it, what is
 * sent back to the routes, and what a failure reads like. The staging token
 * never appears in anything but the request body itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImportPreview, PreviewAgent } from '../../../plugins/agent-import/src/contract.js';

type State = typeof import('../../../plugins/agent-import/src/assistant-state.js');
const loaded = await import('../../../plugins/agent-import/src/assistant-state.js') as State & { default?: State };
const {
  IMPORT_ROLES, UPLOAD_MAX_BYTES, applySummary, failureOf, fileFailure, importOptions, mergeChoices, requestBody, shownChoice,
}: State = loaded.default ?? loaded;

const TOKEN = 'A'.repeat(43);

function agent(over: Partial<PreviewAgent> & { sourceRef: string }): PreviewAgent {
  return { displayName: over.sourceRef, action: 'create', warnings: [], ...over };
}

const PREVIEW: ImportPreview = {
  warnings: ['Two MCP servers use stdio: add them by hand.'],
  agents: [
    agent({
      sourceRef: 'openbot:writer',
      displayName: 'Writer',
      finalName: 'openbot.writer',
      cwd: '/home/someone/writing',
      cwdMissing: true,
      elements: { soul: { count: 1, selected: true }, memory: { count: 12, selected: true }, routines: { count: 2, selected: false } },
    }),
    agent({ sourceRef: 'openbot:coder', displayName: 'Coder', action: 'update', role: 'code', project: 'site' }),
    agent({ sourceRef: 'openbot:ghost', displayName: 'Ghost', action: 'skip', warnings: ['Changed by hand since its import: left as is.'] }),
  ],
};

test('the card shows the preview\'s proposal until the user changes a field: research role, final name, boxes', () => {
  const [writer, coder] = PREVIEW.agents;
  assert.deepEqual(shownChoice(writer!, undefined), {
    include: true,
    lockedOut: false,
    name: 'openbot.writer',
    role: 'research',
    project: null,
    cwd: '/home/someone/writing',
    elements: { soul: true, memory: true, routines: false },
    keepRoutinesActive: false,
  });
  assert.equal(shownChoice(coder!, undefined).role, 'code');
  assert.equal(shownChoice(coder!, undefined).project, 'site');
  assert.equal(shownChoice(coder!, undefined).name, 'Coder');
  const edited = shownChoice(writer!, { sourceRef: 'openbot:writer', name: 'plume', cwd: null, elements: { routines: true } });
  assert.equal(edited.name, 'plume');
  assert.equal(edited.cwd, null);
  assert.deepEqual(edited.elements, { soul: true, memory: true, routines: true });
  assert.equal(edited.keepRoutinesActive, false, 'ticking the routines does not keep them active');
  assert.equal(shownChoice(writer!, { sourceRef: 'openbot:writer', keepRoutinesActive: true }).keepRoutinesActive, true);
  assert.equal(IMPORT_ROLES[0], 'research');
});

test('an agent the engine skips on its own is locked out; one the user left out can come back', () => {
  const [, , ghost] = PREVIEW.agents;
  assert.deepEqual([shownChoice(ghost!, undefined).include, shownChoice(ghost!, undefined).lockedOut], [false, true]);
  const leftOut = shownChoice(ghost!, { sourceRef: 'openbot:ghost', include: false });
  assert.deepEqual([leftOut.include, leftOut.lockedOut], [false, false]);
  assert.equal(shownChoice(ghost!, { sourceRef: 'openbot:ghost', include: true }).include, true);
});

test('a new preview keeps what the user set and drops the agents gone; nothing is set by default', () => {
  const first = mergeChoices({}, PREVIEW);
  assert.deepEqual(first['openbot:coder'], { sourceRef: 'openbot:coder' });
  const edited = { ...first, 'openbot:writer': { sourceRef: 'openbot:writer', name: 'plume', role: 'doc' } };
  const next = mergeChoices(edited, { warnings: [], agents: [PREVIEW.agents[0]!, agent({ sourceRef: 'openbot:new' })] });
  assert.deepEqual(Object.keys(next), ['openbot:writer', 'openbot:new']);
  assert.deepEqual(next['openbot:writer'], { sourceRef: 'openbot:writer', name: 'plume', role: 'doc' });
  assert.deepEqual(next['openbot:new'], { sourceRef: 'openbot:new' });
});

test('options carry only what the user touched, agents in the preview order', () => {
  const choices = mergeChoices({}, PREVIEW);
  choices['openbot:writer'] = { sourceRef: 'openbot:writer', name: '  ', cwd: '   ' };
  choices['openbot:coder'] = { sourceRef: 'openbot:coder', name: ' coder-two ', project: null, keepRoutinesActive: true };
  const options = importOptions('openbot', PREVIEW, choices);
  assert.equal(options.source, 'openbot');
  assert.deepEqual(options.agents, [
    { sourceRef: 'openbot:writer', cwd: null },
    { sourceRef: 'openbot:coder', name: 'coder-two', project: null, keepRoutinesActive: true },
    { sourceRef: 'openbot:ghost' },
  ]);
  // No role is sent unless chosen: it would replace the role of an agent already imported.
  assert.ok(options.agents?.every((choice) => !('role' in choice)));
  assert.equal(importOptions(null, null, {}).source, undefined);
});

test('until the engine answers ready, only the token is sent: the route schema takes nothing else', () => {
  const options = importOptions('rooks', PREVIEW, mergeChoices({}, PREVIEW));
  assert.deepEqual(requestBody(TOKEN, false, options), { token: TOKEN });
  assert.deepEqual(requestBody(TOKEN, true, options), { token: TOKEN, options });
});

test('the summary counts the agents that will be written, and those that replace an import', () => {
  const choices = mergeChoices({}, PREVIEW);
  assert.deepEqual(applySummary(PREVIEW, choices), { included: 2, updated: 1 });
  choices['openbot:coder'] = { sourceRef: 'openbot:coder', include: false };
  assert.deepEqual(applySummary(PREVIEW, choices), { included: 1, updated: 0 });
  // A skipped agent stays out even if a stale choice says otherwise.
  choices['openbot:ghost'] = { sourceRef: 'openbot:ghost', include: true };
  assert.deepEqual(applySummary(PREVIEW, choices), { included: 1, updated: 0 });
  assert.deepEqual(applySummary(null, {}), { included: 0, updated: 0 });
});

test('a failure reads as a message of the assistant when its code is known, the daemon words otherwise', () => {
  assert.deepEqual(failureOf('apply', 501, { error: 'x', code: 'not_implemented' }), { key: 'errors.not_implemented' });
  assert.deepEqual(failureOf('preview', 404, { error: 'x', code: 'not_found' }), { key: 'errors.not_found' });
  assert.deepEqual(failureOf('preview', 422, { error: 'x', code: 'invalid_manifest' }), { key: 'errors.invalid_manifest' });
  assert.deepEqual(failureOf('stage', 413, { error: 'x', code: 'too_large' }), { key: 'errors.too_large', vars: { size: UPLOAD_MAX_BYTES / (1024 * 1024) } });
  assert.deepEqual(failureOf('preview', 401, null), { key: 'errors.unauthorized' });
  assert.deepEqual(failureOf('preview', 403, { error: 'nope' }), { key: 'errors.forbidden' });
  assert.deepEqual(failureOf('preview', 500, { error: 'Something odd.', code: 'weird' }), { text: 'Something odd.' });
  assert.deepEqual(failureOf('preview', 502, 'not json'), { key: 'errors.network' });
});

test('a zip the app relay refuses as JSON says the upload is missing, not that the file is bad (TODO #804)', () => {
  assert.deepEqual(failureOf('stage', 400, { error: 'invalid JSON body' }), { key: 'errors.uploadUnavailable' });
  assert.deepEqual(failureOf('preview', 400, { error: 'invalid JSON body' }), { text: 'invalid JSON body' });
});

test('Hermes read from the daemon\'s disk fails in its own words, not those of a sent archive', () => {
  for (const code of ['not_found', 'too_large', 'archive_changed']) {
    assert.deepEqual(failureOf('hermes/stage', 404, { error: 'x', code }), { key: `errors.hermes.${code}` }, code);
  }
  assert.deepEqual(failureOf('hermes/stage', 403, { error: 'x', code: 'forbidden' }), { key: 'errors.forbidden' });
  assert.deepEqual(failureOf('hermes/stage', 429, { error: 'x', code: 'too_many' }), { key: 'errors.too_many' });
});

test('an empty or oversized file is refused before it is sent', () => {
  assert.deepEqual(fileFailure({ size: 0 }), { key: 'errors.empty' });
  assert.equal(fileFailure({ size: UPLOAD_MAX_BYTES }), null);
  assert.equal((fileFailure({ size: UPLOAD_MAX_BYTES + 1 }) as { key: string }).key, 'errors.too_large');
});

test('every message key the assistant can produce exists in both locales', async () => {
  const { readFileSync } = await import('node:fs');
  const messages = JSON.parse(readFileSync(new URL('../../../plugins/agent-import/src/messages.json', import.meta.url), 'utf8')) as Record<'en' | 'fr', Record<string, string>>;
  assert.deepEqual(Object.keys(messages.fr).sort(), Object.keys(messages.en).sort());
  const codes = ['unauthorized', 'forbidden', 'invalid', 'unsupported_media_type', 'not_a_zip', 'empty', 'too_large', 'too_many', 'not_found', 'archive_changed', 'invalid_manifest', 'not_implemented', 'internal'];
  for (const key of [...codes.map((c) => `errors.${c}`), 'errors.network', 'errors.uploadUnavailable', 'errors.hermes.not_found', 'errors.hermes.too_large', 'errors.hermes.archive_changed', ...IMPORT_ROLES.map((r) => `role.${r}`)]) {
    assert.ok(messages.en[key], key);
  }
  for (const element of ['soul', 'memory', 'skills', 'mcp', 'routines', 'team']) assert.ok(messages.en[`element.${element}`], element);
  for (const status of ['created', 'updated', 'skipped', 'failed']) assert.ok(messages.en[`result.${status}`], status);
  for (const action of ['create', 'update', 'skip']) assert.ok(messages.en[`action.${action}`], action);
});
