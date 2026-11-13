'use client';

/**
 * `kanban.todo.detail`: blocks a plugin adds to the detail of a TO DO idea.
 *
 * The occupant reads the idea from context, never from props: slot entries
 * are registered once and rendered for whichever idea the dialog shows (same
 * contract as `chat.media`). It saves its own data itself, then calls
 * `saved()` so the notebook re-reads the idea — the dialog's Save button only
 * knows the core fields.
 */

import React, { createContext, useContext } from 'react';
import { Slot } from '@/lib/plugin-host/render';
import type { ProjectTodo } from './project-todo-types';

export const TODO_DETAIL_SLOT = 'kanban.todo.detail';

export type TodoDetailValue = { item: ProjectTodo; saved: () => void | Promise<void> };

const TodoDetailContext = createContext<TodoDetailValue | null>(null);

/** The idea the detail dialog shows, for an occupant of `kanban.todo.detail`. */
export function useTodoDetail(): TodoDetailValue | null {
  return useContext(TodoDetailContext);
}

export function TodoDetailSlot(value: TodoDetailValue): React.ReactElement {
  return (
    <TodoDetailContext.Provider value={value}>
      <Slot name={TODO_DETAIL_SLOT} />
    </TodoDetailContext.Provider>
  );
}
