/**
 * Browser annotation events as a third-party plugin receives them (`ctx.events.on`, TODO #468):
 * `browser_annotation_created|updated|sent|resolved|dismissed|purged`. They need
 * `events:subscribe` and `browser:annotations:read`.
 *
 * An event carries the annotation's metadata, never its comment nor anything of the page, and its
 * `origin` (`user` id, `agent` name, `plugin` id, `system` for the retention purge): a plugin drops
 * the echo of its own writes by comparing `origin` to `{ kind: 'plugin', id: ctx.id }`. Audience:
 * the annotation's owner, as for the TO DO events — delivered inside that user's identity when
 * they may use the plugin, never to another account. Deferred, serial per plugin.
 */
import type { BusEvent } from '../bus.js';
import type { BrowserAnnotationEventName } from '../browser-annotations.js';
import { browserAnnotationView } from './browser-annotations-facade.js';
import { createPluginEventSubscriber } from './plugin-event-hub.js';
import { todoEventAudience } from './todo-events.js';

import type {
  PluginBrowserAnnotationEventKind, PluginBrowserAnnotationEvent,
} from './contract/browser-annotations.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginBrowserAnnotationEventKind, PluginBrowserAnnotationEvent, PluginBrowserAnnotationEventMap,
  PluginBrowserAnnotationEventHandler,
} from './contract/browser-annotations.js';

export const PLUGIN_BROWSER_ANNOTATION_EVENT_KINDS = Object.freeze([
  'browser_annotation_created', 'browser_annotation_updated', 'browser_annotation_sent',
  'browser_annotation_resolved', 'browser_annotation_dismissed', 'browser_annotation_purged',
] as const);
/** `PluginBrowserAnnotationEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginBrowserAnnotationEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_BROWSER_ANNOTATION_EVENT_KINDS)[number], PluginBrowserAnnotationEventKind>>;

export function isPluginBrowserAnnotationEventKind(kind: unknown): kind is PluginBrowserAnnotationEventKind {
  return typeof kind === 'string' && (PLUGIN_BROWSER_ANNOTATION_EVENT_KINDS as readonly string[]).includes(kind);
}

const kindOf = (event: BrowserAnnotationEventName): PluginBrowserAnnotationEventKind => `browser_annotation_${event}`;

export const subscribePluginBrowserAnnotationEvent = createPluginEventSubscriber<PluginBrowserAnnotationEventKind, PluginBrowserAnnotationEvent>({
  label: 'browser annotation',
  kindOf: (ev: BusEvent) => (ev.kind === 'browser_annotation' ? kindOf(ev.event) : null),
  translate(ev, pluginId) {
    if (ev.kind !== 'browser_annotation' || !ev.ownerUserId) return null;
    const identity = todoEventAudience(pluginId, ev.ownerUserId);
    if (!identity) return null;
    return {
      identity,
      ev: Object.freeze({
        kind: kindOf(ev.event), profileId: ev.profileId, annotationId: ev.annotationId,
        annotation: browserAnnotationView(ev.annotation),
        ...(ev.reason ? { reason: ev.reason } : {}), origin: Object.freeze({ ...ev.origin }),
      }),
    };
  },
});
