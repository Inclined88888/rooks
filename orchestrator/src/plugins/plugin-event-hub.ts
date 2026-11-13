/**
 * The delivery machinery of an event a third-party plugin receives, for the
 * events built from a bus event (`ctx.events.on`): one bus listener and one
 * serial queue per plugin, every subscription of the plugin behind them.
 *
 *  - the translation is built SYNCHRONOUSLY in the bus callback, i.e. inside the
 *    write that caused it: the snapshot is the state that write left, and the
 *    writer (`currentWriteOrigin()`) is still the store's;
 *  - delivery is deferred and SERIAL per plugin, across all its subscriptions: a
 *    handler that awaits finishes before the next event starts, so two events of
 *    one write reach it in order;
 *  - a handler that throws is logged and does not stop the next one;
 *  - the listener exists while a subscription does.
 */
import { bus, type BusEvent } from '../bus.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';

export type PluginEventTranslation<E> = {
  ev: E;
  /** The identity the handlers run under; `null` = the plugin itself (a job). */
  identity: PluginRequestIdentity | null;
};

export type PluginEventSource<K extends string, E extends { kind: K }> = {
  /** For the log line of a failure. */
  label: string;
  /** The kind a bus event becomes, or `null` for any other bus event. */
  kindOf(ev: BusEvent): K | null;
  /** This plugin's translation of the bus event, or `null` when it is not for it. */
  translate(ev: BusEvent, pluginId: string): PluginEventTranslation<E> | null;
};

export function createPluginEventSubscriber<K extends string, E extends { kind: K }>(
  source: PluginEventSource<K, E>,
): (pluginId: string, kind: K, handler: (ev: E) => void | Promise<void>) => () => void {
  type Handler = (ev: E) => void | Promise<void>;

  class Hub {
    private readonly handlers = new Map<K, Set<Handler>>();
    private readonly queue: PluginEventTranslation<E>[] = [];
    private draining = false;
    private listening = false;

    constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

    private readonly onBus = (ev: BusEvent): void => {
      const kind = source.kindOf(ev);
      if (!kind || !this.handlers.get(kind)?.size) return;
      let translated: PluginEventTranslation<E> | null;
      try { translated = source.translate(ev, this.pluginId); } catch (err) {
        console.error(`[plugin:${this.pluginId}] ${source.label} event translation failed:`, (err as Error).message);
        return;
      }
      if (!translated) return;
      this.queue.push(translated);
      if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
    };

    subscribe(kind: K, handler: Handler): () => void {
      let set = this.handlers.get(kind);
      if (!set) { set = new Set(); this.handlers.set(kind, set); }
      // A wrapper per subscription: the same function subscribed twice is two
      // subscriptions, each removed by its own disposer.
      const entry: Handler = (ev) => handler(ev);
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

  const hubs = new Map<string, Hub>();
  return (pluginId, kind, handler) => {
    let hub = hubs.get(pluginId);
    if (!hub) {
      const created: Hub = new Hub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
      hub = created;
      hubs.set(pluginId, hub);
    }
    return hub.subscribe(kind, handler);
  };
}
