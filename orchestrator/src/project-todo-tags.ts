/**
 * Closed vocabulary of the TO DO notebook tags. Two axes, one value each: how
 * urgent or what kind of item it is, and how far along it is. The list is fixed
 * on purpose (no free-form tags) so the notebook stays scannable. The front end
 * keeps a mirror in `app/src/lib/project-todo-tags.ts` (independent packages).
 */
import type { TodoProgress as ContractTodoProgress, TodoUrgency as ContractTodoUrgency } from './plugins/contract/todos.js';
import type { Assert, Equals } from './type-equality.js';

export const TODO_URGENCIES = ['critical', 'bug', 'minor', 'idea'] as const;
export const TODO_PROGRESSES = ['todo', 'analyzed', 'partial', 'to_test', 'done'] as const;

export type TodoUrgency = (typeof TODO_URGENCIES)[number];
export type TodoProgress = (typeof TODO_PROGRESSES)[number];
/** The public contract spells both lists out; compilation fails if they part. */
type _TodoUrgenciesMatchContract = Assert<Equals<TodoUrgency, ContractTodoUrgency>>;
type _TodoProgressesMatchContract = Assert<Equals<TodoProgress, ContractTodoProgress>>;

export function parseTodoUrgency(v: unknown): TodoUrgency | undefined {
  return TODO_URGENCIES.find((u) => u === v);
}
export function parseTodoProgress(v: unknown): TodoProgress | undefined {
  return TODO_PROGRESSES.find((p) => p === v);
}
