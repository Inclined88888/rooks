'use client';

import dynamic from 'next/dynamic';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const OutcomeBlock = dynamic(() => import('./todo-outcomes/outcome-block').then((m) => m.OutcomeBlock), { ssr: false });

/**
 * Client half of `@timon/todo-outcomes`: the outcome block of a TO DO idea,
 * in the detail dialog. The block hides itself while the daemon keeps idea
 * outcomes off (`TIMON_TODO_OUTCOME_ENABLED`).
 */
export const todoOutcomesClient: BundledClientPlugin = {
  module: '@timon/todo-outcomes',
  apply(ctx) {
    ctx.register({ slot: 'kanban.todo.detail', order: 10 }, OutcomeBlock);
  },
};
