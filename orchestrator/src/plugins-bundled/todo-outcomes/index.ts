/**
 * Module `todo-outcomes` — tells the author of an idea what became of it.
 *
 * An idea of the TO DO notebook (typically a tester's report `TIM-…` or a
 * suggestion `SUG-…`) gets an outcome — fixed, declined, duplicate, needs info,
 * in progress, planned — and a public note. The plugin stores them in its own
 * table, closes the idea on a settling outcome, and publishes `todo_resolved`
 * for a trigger to forward to the channel the idea came from (a chat bot, an
 * issue tracker…).
 *
 * The core knows none of this: the plugin rides the TO DO extension hook of
 * `@timon/kanban` and occupies the `kanban.todo.detail` slot client side.
 * Off unless `TIMON_TODO_OUTCOME_ENABLED` is set: the module loads (its data
 * stays readable, a 403 tells the caller why) but accepts no outcome.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { ensureOutcomeTable } from './store.js';
import { outcomeExtension } from './outcome.js';

export const manifest: ModuleManifest = {
  name: '@timon/todo-outcomes',
  tier: 'opt',
  inject: ['http', 'db', 'settings', 'kanban'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  ensureOutcomeTable();
  registerRoutes(ctx.http.router());
  ctx.effect(() => ctx.kanban.todos.registerExtension(outcomeExtension));
}
