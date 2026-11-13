import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveProgress, PROGRESS_CLASS, TODO_PROGRESSES, TODO_URGENCIES, URGENCY_CLASS,
} from './project-todo-tags';
import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';

test('every tag has a colour and a label in both locales', () => {
  for (const u of TODO_URGENCIES) {
    assert.ok(URGENCY_CLASS[u], u);
    assert.ok(en.projectTodo.urgency[u], `en ${u}`);
    assert.ok(fr.projectTodo.urgency[u], `fr ${u}`);
  }
  for (const p of TODO_PROGRESSES) {
    assert.ok(PROGRESS_CLASS[p], p);
    assert.ok(en.projectTodo.progress[p], `en ${p}`);
    assert.ok(fr.projectTodo.progress[p], `fr ${p}`);
  }
});

test('an untagged older idea reads as todo', () => {
  assert.equal(effectiveProgress(null), 'todo');
  assert.equal(effectiveProgress('to_test'), 'to_test');
});
