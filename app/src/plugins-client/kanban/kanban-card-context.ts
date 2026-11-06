'use client';

/**
 * `kanban.card`: the tile of a Kanban item, a TO DO idea or a task, wherever
 * one is listed — the board's columns, the TO DO widgets' lines (TODO #837).
 *
 * One `single` slot for both natures: one primitive (`BoardCard`), one
 * replacement. The slot passes no props — an entry is registered once and
 * painted for every item — so each host puts its item here and the occupant
 * reads it with `useKanbanCard()`, a union on `kind`.
 *
 * The host owns the data and the gestures: it reads the board, opens the
 * popup, stops a mission, ticks an idea. A replacement paints, and calls the
 * gestures it is handed; it never talks to the daemon for them.
 *
 * Kept free of the product's tiles: `@timon/ui` exports the hook on every page.
 */

import { createContext, useContext } from 'react';
import type { AgentIdentity } from '@/components/agent-avatar';
import type { CatalogTarget } from '@/lib/catalog-target';
import type { ProjectTodo } from './project-todo-types';
import type { Task } from './kanban-task';

/** `card`: a board column's tile. `row`: a compact line of a widget list. */
export type KanbanCardDensity = 'card' | 'row';

type KanbanCardBase = {
  density: KanbanCardDensity;
  /** Opens the item's popup. */
  open: () => void;
};

/** A TO DO idea's tile. */
export type KanbanTodoCardValue = KanbanCardBase & {
  kind: 'todo';
  item: ProjectTodo;
  /** What the tile shows besides the title and tags (a widget's display options). */
  show: { id: boolean; author: boolean; project: boolean };
  /** Ticks the idea done, or opens it again; `null` where the host offers no checkbox. */
  toggleDone: (() => void) | null;
  /**
   * Hands the idea to its project's orchestrator, the way an idea becomes a
   * task; the host tells the user how it went. `null` for an idea without a
   * project, or where the host offers no hand-off.
   */
  handoff: (() => void) | null;
  /** Deletes the idea; `null` where the host offers no deletion. */
  remove: (() => void) | null;
};

/** A task's tile on the board. */
export type KanbanTaskCardValue = KanbanCardBase & {
  kind: 'task';
  task: Task;
  /** The whole board, unfiltered: a filter must not change what a task waits on. */
  board: ReadonlyMap<string, Task>;
  /** The clock the running times are counted against, ticked by the board. */
  now: number;
  agent: AgentIdentity;
  /** The role written on the agent's sheet, as its label; `null` when it has none. */
  agentRole: string | null;
  /** The TO DO idea the task carries out (`todo_id`), when the board holds it. */
  todo: ProjectTodo | null;
  /** The running mission waits for a validation. */
  needsAction: boolean;
  /** The card is being dragged. */
  dragging: boolean;
  /** Where the model catalogue of the task's parameters is read for. */
  modelTarget: CatalogTarget;
  /** What makes the card draggable to another column: spread it on the card's root. */
  drag: { draggable: boolean; onDragStart: () => void; onDragEnd: () => void };
  /** Stops the running mission; the board asks before it does. */
  stop: () => void;
  /** Opens the "mark as merged" dialog of a DONE code task. */
  markMerged: () => void;
  /** Opens the series graph, centred on `focusId`. */
  openGraph: (focusId: string | null) => void;
  /** The task changed from the card itself: the board reads it again. */
  refresh: () => Promise<void> | void;
};

export type KanbanCardValue = KanbanTodoCardValue | KanbanTaskCardValue;

const KanbanCardContext = createContext<KanbanCardValue | null>(null);

export const KanbanCardProvider = KanbanCardContext.Provider;

/** Readable by a plugin that takes the `kanban.card` slot; `null` outside a card host. */
export function useKanbanCard(): KanbanCardValue | null {
  return useContext(KanbanCardContext);
}
