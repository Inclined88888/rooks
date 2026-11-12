import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TODO_DISPLAY, readTodoDisplay, writeTodoDisplay } from './project-todo-display';

test('nothing stored, or garbage: number and author both shown', () => {
  for (const raw of [null, undefined, 'x', [], { v: 1 }, { project: { showId: 'no' } }]) {
    assert.deepEqual(readTodoDisplay(raw, 'project'), DEFAULT_TODO_DISPLAY);
  }
});

test('each widget keeps its own setting', () => {
  const one = writeTodoDisplay(null, 'project', { showId: false, showAuthor: true });
  const both = writeTodoDisplay(one, 'all', { showId: true, showAuthor: false });
  assert.deepEqual(readTodoDisplay(both, 'project'), { showId: false, showAuthor: true });
  assert.deepEqual(readTodoDisplay(both, 'all'), { showId: true, showAuthor: false });
});
