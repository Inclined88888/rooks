import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeProjectTodoChanges } from './project-todo-realtime';

test('todo realtime coalesces bursts and cancels pending reloads on cleanup', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let handler: ((payload: unknown) => void) | undefined;
  let reloads = 0;
  let unsubscribed = false;
  const dispose = subscribeProjectTodoChanges({
    subscribe(topic, listener) {
      assert.equal(topic, 'project-todo.changed');
      handler = listener;
      return () => { unsubscribed = true; handler = undefined; };
    },
  }, () => { reloads++; });
  handler?.({ id: 1 });
  t.mock.timers.tick(100);
  handler?.({ id: 2 });
  t.mock.timers.tick(149);
  assert.equal(reloads, 0);
  t.mock.timers.tick(1);
  assert.equal(reloads, 1);
  handler?.({ id: 3 });
  t.mock.timers.tick(150);
  assert.equal(reloads, 2);
  handler?.({ id: 4 });
  dispose();
  assert.equal(unsubscribed, true);
  t.mock.timers.tick(150);
  assert.equal(reloads, 2);
});
