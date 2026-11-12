import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LEAVE, unloadPrompt } from './unload-prompt.js';

test('the unload question keeps the changes by default, in the user\'s language', () => {
  const en = unloadPrompt('en-US', 'Rooks');
  assert.equal(en.buttons[LEAVE], 'Leave without saving');
  assert.equal(en.defaultId, 1, 'Enter stays');
  assert.equal(en.cancelId, 1, 'Escape stays');
  assert.equal(unloadPrompt('fr-FR', 'Rooks').buttons[LEAVE], 'Quitter sans enregistrer');
});

test('every page of a UI window answers will-prevent-unload, or a modified document would block quitting in silence', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  // Multi-window V4: the interface lives in one view per machine, each built by `createPage`.
  const createPage = source.slice(source.indexOf('function createPage('), source.indexOf('function enterMachine('));
  assert.match(createPage, /contents\.on\('will-prevent-unload'/);
  // A page is closed through its own beforeunload, never torn down unasked while its window lives.
  assert.match(source, /contents\.close\(\{ waitForBeforeUnload: true \}\)/);
});
