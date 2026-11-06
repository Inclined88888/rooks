/**
 * Who is writing a Kanban task right now, for the `origin` that
 * `task_created` / `task_updated` / `task_assigned` / `task_deleted` carry to
 * plugins (`plugins/task-events.ts`).
 *
 * The TO DO notebook already solved it (`todo-origin.ts`): the writer runs
 * inside `withTodoOrigin`, the event listener reads `currentTodoOrigin()`
 * synchronously inside the bus callback. Tasks share that store rather than
 * open a second one: a write nested in another (a promoted idea creating its
 * task) then reports the innermost writer, and there is one place to look.
 * The names below only say what a task reader means.
 */
export {
  withTodoOrigin as withTaskOrigin,
  currentTodoOrigin as currentTaskOrigin,
  todoOriginFromRequest as taskOriginFromRequest,
  type TodoOrigin as TaskOrigin,
} from './todo-origin.js';
