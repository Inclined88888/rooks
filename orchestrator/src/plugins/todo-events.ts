/**
 * TO DO events as a third-party plugin receives them (`ctx.events.on`).
 *
 * The bus events stay as they are — the triggers and the Discord bot read
 * them, their shape is frozen. A plugin gets a translation instead, built
 * SYNCHRONOUSLY in the bus callback, i.e. inside the write that caused it:
 *
 *  - the snapshot is the idea as that write left it (a re-read later would
 *    show a newer write), with its links;
 *  - `origin` is the writer (`todo-origin.ts`), so a connector drops the echo
 *    of what it wrote itself;
 *  - the account filter is the one of the plugin's reads: an idea it created
 *    in a job (`plugin:<id>`) comes to its job, an idea of a user who may use
 *    the plugin comes inside that user's identity — the handler then reads and
 *    writes as a callback of that account does (`integrationRequestIdentity`).
 *    System ideas and ideas of another plugin never leave.
 *
 * Delivery is deferred and SERIAL per plugin, across all its subscriptions:
 * a handler that awaits (an outbox post, a lookup) finishes before the next
 * event starts, so `todo_resolved` is handled before the `todo_done` that
 * follows it, and the posts they make are queued in that order.
 */
import { bus, type BusEvent } from '../bus.js';
import { dbApi } from '../db.js';
import { currentTodoOrigin, type TodoOrigin } from '../todo-origin.js';
import { PLUGIN_OWNER_PREFIX } from '../users/api-tokens.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { integrationRequestIdentity } from './integration-host.js';

import type {
  PluginTodoEventKind, PluginTodoEventLink, PluginTodoEvent, PluginTodoEventHandler,
} from './contract/todos.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginTodoEventKind, PluginTodoOrigin, PluginTodoEventLink, PluginTodoDoneEvent,
  PluginTodoResolvedEvent, PluginTodoDeletedEvent, PluginTodoEvent, PluginTodoEventMap,
  PluginTodoEventHandler,
} from './contract/todos.js';

export const PLUGIN_TODO_EVENT_KINDS = Object.freeze(['todo_done', 'todo_resolved', 'todo_deleted'] as const);
/** `PluginTodoEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginTodoEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_TODO_EVENT_KINDS)[number], PluginTodoEventKind>>;

export function isPluginTodoEventKind(kind: unknown): kind is PluginTodoEventKind {
  return typeof kind === 'string' && (PLUGIN_TODO_EVENT_KINDS as readonly string[]).includes(kind);
}

function linksOf(todoId: number): readonly PluginTodoEventLink[] {
  return Object.freeze(dbApi.listTodoExternalRefs([todoId]).map((l) => Object.freeze({
    provider: l.provider, ref: l.ref, url: l.url, label: l.label, plugin_id: l.plugin_id, created_at: l.created_at,
  })));
}

/** The plugin's translation of a bus event, or `null` for anything else. */
export function pluginTodoEventFromBus(ev: BusEvent, origin: TodoOrigin): PluginTodoEvent | null {
  switch (ev.kind) {
    case 'todo_done': {
      const row = dbApi.getProjectTodo(ev.todoId);
      if (!row) return null;
      return Object.freeze({
        kind: 'todo_done', todoId: ev.todoId, previousProgress: ev.previousProgress, origin,
        todo: Object.freeze({
          id: row.id, text: row.text, project: row.project, owner_user_id: row.owner_user_id,
          progress: row.progress, urgency: row.urgency, done_at: row.done_at, links: linksOf(row.id),
        }),
      });
    }
    case 'todo_resolved': {
      // The bus snapshot, never a re-read: two outcomes in one tick stay two.
      const t = ev.todo;
      return Object.freeze({
        kind: 'todo_resolved', todoId: ev.todoId, previousResolution: ev.previousResolution, origin,
        todo: Object.freeze({
          id: t.id, text: t.text, project: t.project, owner_user_id: t.owner_user_id,
          resolution: t.resolution, public_note: t.public_note, duplicate_of: t.duplicate_of, links: linksOf(t.id),
        }),
      });
    }
    case 'todo_deleted':
      return Object.freeze({ kind: 'todo_deleted', todoId: ev.todoId, todo: ev.todo, origin });
    default:
      return null;
  }
}

/**
 * The identity a plugin's handler runs under for an idea of `ownerUserId`,
 * `undefined` = not delivered. `null` = the plugin's own job.
 */
export function todoEventAudience(pluginId: string, ownerUserId: string | null): PluginRequestIdentity | null | undefined {
  if (ownerUserId === null) return undefined;
  if (ownerUserId === `${PLUGIN_OWNER_PREFIX}${pluginId}`) return null;
  if (ownerUserId.startsWith(PLUGIN_OWNER_PREFIX)) return undefined;
  try {
    return integrationRequestIdentity(pluginId, ownerUserId);
  } catch {
    // Inactive account, or one that may not use this plugin.
    return undefined;
  }
}

type Delivery = { ev: PluginTodoEvent; identity: PluginRequestIdentity | null };

/**
 * Per-plugin hub: one bus listener, one serial queue, every subscription of
 * the plugin behind it. The listener exists while one subscription does.
 */
class PluginTodoEventHub {
  private readonly handlers = new Map<PluginTodoEventKind, Set<PluginTodoEventHandler>>();
  private readonly queue: Delivery[] = [];
  private draining = false;
  private listening = false;

  constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

  private readonly onBus = (ev: BusEvent): void => {
    if (!isPluginTodoEventKind(ev.kind) || !this.handlers.get(ev.kind)?.size) return;
    // Synchronous on purpose: the origin store and the row are the write's.
    let translated: PluginTodoEvent | null;
    try { translated = pluginTodoEventFromBus(ev, currentTodoOrigin()); } catch (err) {
      console.error(`[plugin:${this.pluginId}] todo event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    const identity = todoEventAudience(this.pluginId, translated.todo.owner_user_id);
    if (identity === undefined) return;
    this.queue.push({ ev: translated, identity });
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  };

  subscribe(kind: PluginTodoEventKind, handler: PluginTodoEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    // A wrapper per subscription: the same function subscribed twice is two
    // subscriptions, each removed by its own disposer.
    const entry: PluginTodoEventHandler = (ev) => handler(ev);
    set.add(entry);
    if (!this.listening) { bus.on('event', this.onBus); this.listening = true; }
    return () => {
      set.delete(entry);
      if ([...this.handlers.values()].some((s) => s.size)) return;
      bus.off('event', this.onBus);
      this.listening = false;
      this.onEmpty();
    };
  }

  private async drain(): Promise<void> {
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const { ev, identity } = next;
        for (const handler of [...(this.handlers.get(ev.kind) ?? [])]) {
          const run = () => handler(ev);
          try {
            await (identity ? runPluginRequest(identity, run) : run());
          } catch (err) {
            console.error(`[plugin:${this.pluginId}] ${ev.kind} handler failed:`, (err as Error).message);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

const hubs = new Map<string, PluginTodoEventHub>();

export function subscribePluginTodoEvent(
  pluginId: string,
  kind: PluginTodoEventKind,
  handler: PluginTodoEventHandler,
): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) {
    const created: PluginTodoEventHub = new PluginTodoEventHub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
    hub = created;
    hubs.set(pluginId, hub);
  }
  return hub.subscribe(kind, handler);
}
