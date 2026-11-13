/**
 * Rule lifecycle events as a third-party plugin receives them
 * (`ctx.events.on`, permissions `events:subscribe` + `memory:read`):
 * `memory_rule_added` and `memory_rule_removed`.
 *
 * Emitted by the shared write functions (`addMemoryRule`, `deleteMemoryRule`),
 * so the HTTP route, the CLI, the MCP tools and `ctx.memory` all fire them.
 * Rules belong to no account, so the audience is the plugin's own view of a
 * job (`rules.list` there): a plugin hears only about rules IT wrote — what
 * matters is that it learns when one of them is removed, and by whom. Rules
 * that arrive another way (a proposal accepted, the nightly synthesis, an
 * edit of the status or scope) do not go through these functions and emit
 * nothing; archiving or superseding a rule is not an event.
 *
 * Delivery is deferred and serial per plugin, like the TO DO events; the
 * handler runs as the plugin itself (a job), never in the identity of the
 * request that caused the event (`outsidePluginRequest`: the async context
 * would otherwise follow the deferred drain).
 */
import type { MemoryRuleRow } from './db.js';
import { outsidePluginRequest } from './plugins/als.js';

import type {
  PluginMemoryEventKind, PluginMemoryActor, PluginMemoryRuleSnapshot, PluginMemoryEvent,
  PluginMemoryEventHandler,
} from './plugins/contract/memory.js';
import type { Assert, Equals } from './type-equality.js';
export type {
  PluginMemoryEventKind, PluginMemoryActor, PluginMemoryRuleSnapshot, PluginMemoryRuleAddedEvent,
  PluginMemoryRuleRemovedEvent, PluginMemoryEvent, PluginMemoryEventMap, PluginMemoryEventHandler,
} from './plugins/contract/memory.js';

export const PLUGIN_MEMORY_EVENT_KINDS = Object.freeze(['memory_rule_added', 'memory_rule_removed'] as const);
/** `PluginMemoryEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginMemoryEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_MEMORY_EVENT_KINDS)[number], PluginMemoryEventKind>>;

export function isPluginMemoryEventKind(kind: unknown): kind is PluginMemoryEventKind {
  return typeof kind === 'string' && (PLUGIN_MEMORY_EVENT_KINDS as readonly string[]).includes(kind);
}

const pluginIdOfSource = (source: string): string | null => (source.startsWith('plugin:') ? source.slice('plugin:'.length) : null);

const snapshot = (r: MemoryRuleRow): PluginMemoryRuleSnapshot => Object.freeze({
  id: r.id, scope: r.scope, project: r.project, agent: r.agent, role: r.role, kind: r.kind, tier: r.tier, text: r.text,
});

type Hub = { handlers: Map<PluginMemoryEventKind, Set<PluginMemoryEventHandler>>; queue: PluginMemoryEvent[]; draining: boolean };
const hubs = new Map<string, Hub>();

async function drain(pluginId: string, hub: Hub): Promise<void> {
  try {
    for (let ev = hub.queue.shift(); ev; ev = hub.queue.shift()) {
      for (const handler of [...(hub.handlers.get(ev.kind) ?? [])]) {
        try { await handler(ev); } catch (err) {
          console.error(`[plugin:${pluginId}] ${ev.kind} handler failed:`, (err as Error).message);
        }
      }
    }
  } finally {
    hub.draining = false;
  }
}

/** Called by the write functions with the row as that write left it. */
export function emitMemoryRuleEvent(kind: PluginMemoryEventKind, rule: MemoryRuleRow, actor: PluginMemoryActor): void {
  const owner = pluginIdOfSource(rule.source);
  if (!owner) return;
  const hub = hubs.get(owner);
  if (!hub?.handlers.get(kind)?.size) return;
  const ev: PluginMemoryEvent = Object.freeze({ kind, ruleId: rule.id, rule: snapshot(rule), origin: Object.freeze({ ...actor }) });
  hub.queue.push(ev);
  if (!hub.draining) { hub.draining = true; setImmediate(() => { void outsidePluginRequest(() => drain(owner, hub)); }); }
}

export function subscribePluginMemoryEvent(pluginId: string, kind: PluginMemoryEventKind, handler: PluginMemoryEventHandler): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) { hub = { handlers: new Map(), queue: [], draining: false }; hubs.set(pluginId, hub); }
  let set = hub.handlers.get(kind);
  if (!set) { set = new Set(); hub.handlers.set(kind, set); }
  const entry: PluginMemoryEventHandler = (ev) => handler(ev);
  set.add(entry);
  return () => {
    set.delete(entry);
    const live = hubs.get(pluginId);
    if (live && [...live.handlers.values()].every((s) => s.size === 0)) hubs.delete(pluginId);
  };
}
