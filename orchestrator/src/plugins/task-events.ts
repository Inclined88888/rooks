/**
 * Kanban lifecycle events as a third-party plugin receives them
 * (`ctx.events.on('task_created' | 'task_updated' | 'task_assigned' |
 * 'task_deleted' | 'task_unblocked')`).
 *
 * Same contract as the TO DO events (`todo-events.ts`): the bus events stay
 * ids and field names, the plugin gets a translation built SYNCHRONOUSLY in the
 * bus callback, i.e. inside the write that caused it —
 *
 *  - the snapshot is the task as that write left it, with its links (a
 *    re-read later would show a newer write);
 *  - `origin` is the writer (`task-origin.ts`), so a sync plugin drops the echo
 *    of what it wrote itself (`origin.kind === 'plugin' && origin.id === ctx.id`);
 *  - the audience is the one of the plugin's reads: a task it created in a job
 *    (`plugin:<id>`) comes to its job; a task of a user who may use the plugin
 *    comes inside that user's identity, so the handler reads and writes as a
 *    callback of that account does; a task of a project the operator granted
 *    (`pluginPolicy.kanban.projects`, with `kanban:read:project` declared)
 *    comes to its job. Everything else never leaves.
 *
 * `task_done` / `task_blocked` are NOT here: they keep their historical raw
 * shape (`{ kind, taskId }`). The status move they announce also arrives as a
 * `task_updated` with `changed` including `status` and `previous.status`, which
 * is the one a sync needs. `task_unblocked` arrives here (with the snapshot).
 *
 * Delivery is deferred and SERIAL per plugin, across all its subscriptions.
 */
import { bus, type BusEvent, type TaskDeletedSnapshot } from '../bus.js';
import { dbApi } from '../db.js';
import { currentTaskOrigin, type TaskOrigin } from '../task-origin.js';
import { PLUGIN_OWNER_PREFIX } from '../users/api-tokens.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { integrationRequestIdentity } from './integration-host.js';
import { grantedKanbanProjects } from './policy.js';
import { projectOfTask, toPluginTask } from './tasks-facade.js';

import type { PluginTaskEventKind, PluginTaskEvent, PluginTaskEventHandler } from './contract/tasks.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginTaskEventKind, PluginTaskOrigin, PluginTaskCreatedEvent, PluginTaskUpdatedEvent,
  PluginTaskAssignedEvent, PluginTaskUnblockedEvent, PluginTaskDeletedEvent, PluginTaskEvent,
  PluginTaskEventMap, PluginTaskEventHandler,
} from './contract/tasks.js';

export const PLUGIN_TASK_EVENT_KINDS = Object.freeze([
  'task_created', 'task_updated', 'task_assigned', 'task_deleted', 'task_unblocked',
] as const);
/** `PluginTaskEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginTaskEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_TASK_EVENT_KINDS)[number], PluginTaskEventKind>>;

export function isPluginTaskEventKind(kind: unknown): kind is PluginTaskEventKind {
  return typeof kind === 'string' && (PLUGIN_TASK_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The plugin's translation of a bus event, or `null` for anything else (or a task already gone). */
export function pluginTaskEventFromBus(ev: BusEvent, origin: TaskOrigin): PluginTaskEvent | null {
  switch (ev.kind) {
    case 'task_created':
    case 'task_updated':
    case 'task_assigned':
    case 'task_unblocked': {
      const row = dbApi.getTask(ev.taskId);
      if (!row) return null;
      const task = Object.freeze(toPluginTask(row));
      if (ev.kind === 'task_created') return Object.freeze({ kind: ev.kind, taskId: ev.taskId, task, origin });
      if (ev.kind === 'task_unblocked') return Object.freeze({ kind: ev.kind, taskId: ev.taskId, task, origin });
      if (ev.kind === 'task_assigned') {
        return Object.freeze({ kind: ev.kind, taskId: ev.taskId, task, previousAgent: ev.previousAgent, origin });
      }
      return Object.freeze({ kind: ev.kind, taskId: ev.taskId, task, changed: ev.changed, previous: ev.previous, origin });
    }
    case 'task_deleted': {
      const t: TaskDeletedSnapshot = ev.task;
      return Object.freeze({ kind: ev.kind, taskId: ev.taskId, task: t, origin });
    }
    default:
      return null;
  }
}

/**
 * The identity a plugin's handler runs under for a task, `undefined` = not
 * delivered, `null` = the plugin's own job.
 */
export function taskEventAudience(
  pluginId: string,
  task: Readonly<{ owner_user_id: string | null; project: string | null; agent_name: string }>,
  readsProjects: boolean,
): PluginRequestIdentity | null | undefined {
  const owner = task.owner_user_id;
  if (owner === `${PLUGIN_OWNER_PREFIX}${pluginId}`) return null;
  const grantedJob = (): null | undefined => {
    if (!readsProjects) return undefined;
    const granted = grantedKanbanProjects(pluginId);
    if (granted.length === 0) return undefined;
    const project = projectOfTask(task);
    return project !== null && granted.includes(project) ? null : undefined;
  };
  if (owner === null || owner.startsWith(PLUGIN_OWNER_PREFIX)) return grantedJob();
  try {
    return integrationRequestIdentity(pluginId, owner);
  } catch {
    // Inactive account, or one that may not use this plugin.
    return grantedJob();
  }
}

type Delivery = { ev: PluginTaskEvent; identity: PluginRequestIdentity | null };

/**
 * Per-plugin hub: one bus listener, one serial queue, every subscription of
 * the plugin behind it. The listener exists while one subscription does.
 */
class PluginTaskEventHub {
  private readonly handlers = new Map<PluginTaskEventKind, Set<PluginTaskEventHandler>>();
  private readonly queue: Delivery[] = [];
  private draining = false;
  private listening = false;

  constructor(
    private readonly pluginId: string,
    private readonly readsProjects: boolean,
    private readonly onEmpty: () => void,
  ) {}

  private readonly onBus = (ev: BusEvent): void => {
    if (!isPluginTaskEventKind(ev.kind) || !this.handlers.get(ev.kind)?.size) return;
    // Synchronous on purpose: the origin store and the row are the write's.
    let translated: PluginTaskEvent | null;
    try { translated = pluginTaskEventFromBus(ev, currentTaskOrigin()); } catch (err) {
      console.error(`[plugin:${this.pluginId}] task event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    const identity = taskEventAudience(this.pluginId, translated.task, this.readsProjects);
    if (identity === undefined) return;
    this.queue.push({ ev: translated, identity });
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  };

  subscribe(kind: PluginTaskEventKind, handler: PluginTaskEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    // A wrapper per subscription: the same function subscribed twice is two
    // subscriptions, each removed by its own disposer.
    const entry: PluginTaskEventHandler = (ev) => handler(ev);
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

// Keyed by plugin AND by what its manifest asks: the audience depends on it, so
// two loads of one id that disagree never share a queue.
const hubs = new Map<string, PluginTaskEventHub>();

/** `readsProjects`: the plugin declared `kanban:read:project` (the operator's grant is read at delivery). */
export function subscribePluginTaskEvent(
  pluginId: string,
  kind: PluginTaskEventKind,
  handler: PluginTaskEventHandler,
  readsProjects = false,
): () => void {
  const key = `${pluginId}|${readsProjects ? 'projects' : 'own'}`;
  let hub = hubs.get(key);
  if (!hub) {
    const created: PluginTaskEventHub = new PluginTaskEventHub(pluginId, readsProjects, () => { if (hubs.get(key) === created) hubs.delete(key); });
    hub = created;
    hubs.set(key, hub);
  }
  return hub.subscribe(kind, handler);
}
