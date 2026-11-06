/**
 * Project events as a third-party plugin receives them (`ctx.events.on`, API 10):
 * `project_created` and `project_updated`.
 *
 * The bus event is relayed after a translation built SYNCHRONOUSLY in the bus
 * callback, so `project` is the row as that write left it, not as a later one
 * did. `origin` is the writer (`user` account id, `agent` name, `plugin` id,
 * `system`): a connector mirroring projects drops the echo of its own writes by
 * comparing it to its id. The working directory is never part of an event; a
 * plugin that may manage projects reads it with `ctx.projects.get`.
 *
 * Projects belong to nobody, so there is no account to filter on: every plugin
 * holding `projects:read` receives every project event, and delivery runs as the
 * plugin itself (a job). It is deferred and serial per plugin, in event order,
 * like the TO DO events.
 */
import { bus, type BusEvent } from '../bus.js';
import { dbApi } from '../db.js';
import { projectView } from './projects-facade.js';

import type {
  PluginProjectEventKind, PluginProjectEvent, PluginProjectEventHandler,
} from './contract/projects.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginProjectEventKind, PluginProjectOrigin, PluginProjectCreatedEvent, PluginProjectUpdatedEvent,
  PluginProjectEvent, PluginProjectEventMap, PluginProjectEventHandler,
} from './contract/projects.js';

export const PLUGIN_PROJECT_EVENT_KINDS = Object.freeze(['project_created', 'project_updated'] as const);
/** `PluginProjectEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginProjectEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_PROJECT_EVENT_KINDS)[number], PluginProjectEventKind>>;

export function isPluginProjectEventKind(kind: unknown): kind is PluginProjectEventKind {
  return typeof kind === 'string' && (PLUGIN_PROJECT_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The plugin's translation of a bus event, or `null` for anything else (or a project deleted since). */
export function pluginProjectEventFromBus(ev: BusEvent, pluginId: string): PluginProjectEvent | null {
  if (ev.kind !== 'project_created' && ev.kind !== 'project_updated') return null;
  const row = dbApi.getProjectRow(ev.slug);
  if (!row) return null;
  const project = Object.freeze(projectView(row, pluginId, false));
  const origin = Object.freeze({ ...ev.origin });
  return ev.kind === 'project_created'
    ? Object.freeze({ kind: 'project_created', slug: ev.slug, project, origin })
    : Object.freeze({ kind: 'project_updated', slug: ev.slug, changed: Object.freeze([...ev.changed]), project, origin });
}

class PluginProjectEventHub {
  private readonly handlers = new Map<PluginProjectEventKind, Set<PluginProjectEventHandler>>();
  private readonly queue: PluginProjectEvent[] = [];
  private draining = false;
  private listening = false;

  constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

  private readonly onBus = (ev: BusEvent): void => {
    if ((ev.kind !== 'project_created' && ev.kind !== 'project_updated') || !this.handlers.get(ev.kind)?.size) return;
    let translated: PluginProjectEvent | null;
    try { translated = pluginProjectEventFromBus(ev, this.pluginId); } catch (err) {
      console.error(`[plugin:${this.pluginId}] project event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    this.queue.push(translated);
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  };

  subscribe(kind: PluginProjectEventKind, handler: PluginProjectEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    const entry: PluginProjectEventHandler = (ev) => handler(ev);
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
        for (const handler of [...(this.handlers.get(next.kind) ?? [])]) {
          try { await handler(next); } catch (err) {
            console.error(`[plugin:${this.pluginId}] ${next.kind} handler failed:`, (err as Error).message);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

const hubs = new Map<string, PluginProjectEventHub>();

export function subscribePluginProjectEvent(
  pluginId: string,
  kind: PluginProjectEventKind,
  handler: PluginProjectEventHandler,
): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) {
    const created: PluginProjectEventHub = new PluginProjectEventHub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
    hub = created;
    hubs.set(pluginId, hub);
  }
  return hub.subscribe(kind, handler);
}
