/**
 * Extensions of a TO DO idea: fields a plugin adds to the notebook without the
 * core knowing what they mean.
 *
 * The core owns the idea (text, tags, open/done). A plugin that attaches its
 * own data to an idea registers here the PATCH keys it owns; the route hands
 * them over untouched and runs the plugin inside the same write:
 *
 *   1. `prepare` validates the plugin's part of the body before anything is
 *      written, and may ask the core to close the idea;
 *   2. the core writes its row;
 *   3. `commit` stores the plugin's data and publishes what it has to say;
 *   4. the core publishes `todo_done` if the write closed the idea.
 *
 * Step 3 before step 4 is the point of the hook: a listener told what the
 * plugin decided first can recognise the closure that follows it.
 */
import type { ProjectTodoRow } from './db.js';

/** What the core part of the same write asks for, as the route parsed it. */
export type TodoCoreIntent = Readonly<{ progress?: string; status?: string }>;

export type TodoExtensionPlan = {
  /**
   * Close the idea (progress `done`). Ignored when the same write sets
   * `progress` or `status` itself, or when the idea was promoted: a promoted
   * idea is closed by its chain.
   */
  close?: boolean;
  /** Runs once the core row is written, before `todo_done` goes out. */
  commit(updated: ProjectTodoRow, existing: ProjectTodoRow): void;
};

export type TodoExtension = {
  /** Owner, for errors and for unregistering. */
  id: string;
  /** PATCH keys this extension owns. */
  fields: readonly string[];
  /**
   * Validates the extension's part of `body`; nothing is written yet. Throws
   * `TodoExtensionError` to refuse the whole write. `null` = nothing to do.
   */
  prepare(existing: ProjectTodoRow, body: Readonly<Record<string, unknown>>, core: TodoCoreIntent): TodoExtensionPlan | null;
};

/** A refusal the route turns into `status` with `message` as the error. */
export class TodoExtensionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const extensions = new Map<string, TodoExtension>();

export function registerTodoExtension(ext: TodoExtension): () => void {
  for (const other of extensions.values()) {
    const shared = other.fields.find((f) => ext.fields.includes(f));
    if (shared !== undefined && other.id !== ext.id) {
      throw new Error(`TO DO field "${shared}" is already owned by ${other.id}`);
    }
  }
  extensions.set(ext.id, ext);
  return () => { if (extensions.get(ext.id) === ext) extensions.delete(ext.id); };
}

/** PATCH keys some extension owns right now: what a write may carry beyond the core. */
export function todoExtensionFields(): Set<string> {
  const fields = new Set<string>();
  for (const ext of extensions.values()) for (const f of ext.fields) fields.add(f);
  return fields;
}

/**
 * The plans of every extension whose fields `body` carries. Throws what an
 * extension throws, before any write.
 */
export function prepareTodoExtensions(
  existing: ProjectTodoRow,
  body: Readonly<Record<string, unknown>>,
  core: TodoCoreIntent,
): TodoExtensionPlan[] {
  const plans: TodoExtensionPlan[] = [];
  for (const ext of extensions.values()) {
    if (!ext.fields.some((f) => body[f] !== undefined)) continue;
    const plan = ext.prepare(existing, body, core);
    if (plan) plans.push(plan);
  }
  return plans;
}
