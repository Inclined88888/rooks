/**
 * Document events as a third-party plugin receives them (`ctx.events.on`,
 * ADR-MCPUI D8): `ui_document_created` and `ui_document_resolved`.
 *
 * The mission's own events (`ui_document`, `ui_document_resolved`) are never
 * relayed as they are — they are not in `PLUGIN_EVENT_KINDS`. Each plugin gets
 * a translation built SYNCHRONOUSLY in the bus callback, so the snapshot is
 * the document as that write left it, and the document in it is projected
 * for THAT plugin: the reply is there only on documents it created.
 *
 * Audience: the account filter of the plugin's reads (`todoEventAudience`) on
 * the mission's owner — a document on a mission of its job comes to its job,
 * one on a mission of a user who may use the plugin comes in that user's
 * identity. Delivery is deferred and serial per plugin, like the TO DO events.
 */
import { bus, type BusEvent } from '../bus.js';
import { dbApi } from '../db.js';
import {
  projectUiDocument,
  UI_DOCUMENT_EVENT,
  UI_DOCUMENT_RESOLVED_EVENT,
} from '../plugins-bundled/ui-documents/model.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { todoEventAudience } from './todo-events.js';

import type {
  PluginUiDocumentEventKind, PluginUiDocumentActor, PluginUiDocumentEvent, PluginUiDocumentEventHandler,
} from './contract/ui-documents.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginUiDocumentEventKind, PluginUiDocumentActor, PluginUiDocumentCreatedEvent,
  PluginUiDocumentResolvedEvent, PluginUiDocumentEvent, PluginUiDocumentEventMap,
  PluginUiDocumentEventHandler,
} from './contract/ui-documents.js';

export const PLUGIN_UI_DOCUMENT_EVENT_KINDS = Object.freeze(['ui_document_created', 'ui_document_resolved'] as const);
/** `PluginUiDocumentEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginUiDocumentEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_UI_DOCUMENT_EVENT_KINDS)[number], PluginUiDocumentEventKind>>;

export function isPluginUiDocumentEventKind(kind: unknown): kind is PluginUiDocumentEventKind {
  return typeof kind === 'string' && (PLUGIN_UI_DOCUMENT_EVENT_KINDS as readonly string[]).includes(kind);
}

function actor(raw: unknown): PluginUiDocumentActor | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if (typeof kind !== 'string') return null;
  return Object.freeze({ kind, id: typeof id === 'string' ? id : null });
}

/** The plugin's translation of a mission event, or `null` for anything else. */
export function pluginUiDocumentEventFromBus(ev: BusEvent, pluginId: string): { ev: PluginUiDocumentEvent; ownerUserId: string } | null {
  if (ev.kind !== 'event' || (ev.type !== UI_DOCUMENT_EVENT && ev.type !== UI_DOCUMENT_RESOLVED_EVENT)) return null;
  const id = (ev.payload as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') return null;
  const row = dbApi.getUiDocument(id);
  if (!row) return null;
  const document = Object.freeze(projectUiDocument(row, { kind: 'plugin', id: pluginId }));
  const creator = Object.freeze({ kind: row.origin_kind, id: row.origin_id });
  if (ev.type === UI_DOCUMENT_EVENT) {
    return { ownerUserId: row.owner_user_id, ev: Object.freeze({ kind: 'ui_document_created', documentId: row.id, document, creator, origin: creator }) };
  }
  if (row.status !== 'answered' && row.status !== 'dismissed') return null;
  const origin = actor((ev.payload as { resolvedBy?: unknown }).resolvedBy)
    ?? Object.freeze({ kind: row.resolved_by_kind ?? 'unknown', id: row.resolved_by_id });
  return {
    ownerUserId: row.owner_user_id,
    ev: Object.freeze({ kind: 'ui_document_resolved', documentId: row.id, status: row.status, document, creator, origin }),
  };
}

type Delivery = { ev: PluginUiDocumentEvent; identity: PluginRequestIdentity | null };

class PluginUiDocumentEventHub {
  private readonly handlers = new Map<PluginUiDocumentEventKind, Set<PluginUiDocumentEventHandler>>();
  private readonly queue: Delivery[] = [];
  private draining = false;
  private listening = false;

  constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

  private readonly onBus = (ev: BusEvent): void => {
    if (ev.kind !== 'event') return;
    const kind: PluginUiDocumentEventKind | null = ev.type === UI_DOCUMENT_EVENT ? 'ui_document_created'
      : ev.type === UI_DOCUMENT_RESOLVED_EVENT ? 'ui_document_resolved' : null;
    if (!kind || !this.handlers.get(kind)?.size) return;
    let translated: ReturnType<typeof pluginUiDocumentEventFromBus>;
    try { translated = pluginUiDocumentEventFromBus(ev, this.pluginId); } catch (err) {
      console.error(`[plugin:${this.pluginId}] ui document event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    const identity = todoEventAudience(this.pluginId, translated.ownerUserId);
    if (identity === undefined) return;
    this.queue.push({ ev: translated.ev, identity });
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  };

  subscribe(kind: PluginUiDocumentEventKind, handler: PluginUiDocumentEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    const entry: PluginUiDocumentEventHandler = (ev) => handler(ev);
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

const hubs = new Map<string, PluginUiDocumentEventHub>();

export function subscribePluginUiDocumentEvent(
  pluginId: string,
  kind: PluginUiDocumentEventKind,
  handler: PluginUiDocumentEventHandler,
): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) {
    const created: PluginUiDocumentEventHub = new PluginUiDocumentEventHub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
    hub = created;
    hubs.set(pluginId, hub);
  }
  return hub.subscribe(kind, handler);
}
