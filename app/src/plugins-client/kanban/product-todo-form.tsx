'use client';

/**
 * The product's occupant of `todo.form`: the idea's detail in edition, the
 * quick entry in creation, both laid out on `DetailShell` inside the host's
 * `DetailFrame` and saving through the host (`useTodoForm()`), like a
 * replacement (TODO #837).
 */

import type { ReactElement } from 'react';
import { ProjectTodoCreate } from './project-todo-create-dialog';
import { ProjectTodoDetail } from './project-todo-detail-dialog';
import { useTodoForm } from './todo-form-context';

export function ProductTodoForm(): ReactElement | null {
  const host = useTodoForm();
  if (!host) return null;
  return host.mode === 'edit' && host.item ? <ProjectTodoDetail /> : <ProjectTodoCreate />;
}
