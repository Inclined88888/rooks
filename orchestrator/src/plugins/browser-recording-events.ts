/**
 * Browser recording events as a third-party plugin receives them (`ctx.events.on`, TODO #461):
 * `browser_recording_started|stopped|reviewed|learned|purged`. They need `events:subscribe` and
 * `browser:recordings:read`.
 *
 * An event carries the recording's metadata, never a step, and its `origin` (`user` id, `agent`
 * name, `plugin` id, `system` for the retention purge): a plugin drops the echo of its own writes
 * by comparing `origin` to `{ kind: 'plugin', id: ctx.id }`. Audience: the recording's owner, as
 * for the TO DO events — delivered inside that user's identity when they may use the plugin,
 * never to another account. Deferred, serial per plugin.
 */
import type { BusEvent } from '../bus.js';
import type { BrowserRecordingEventName } from '../browser-recordings.js';
import { browserRecordingView } from './browser-recordings-facade.js';
import { createPluginEventSubscriber } from './plugin-event-hub.js';
import { todoEventAudience } from './todo-events.js';

import type {
  PluginBrowserRecordingEventKind, PluginBrowserRecordingEvent,
} from './contract/browser-recordings.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginBrowserRecordingEventKind, PluginBrowserRecordingEvent, PluginBrowserRecordingEventMap,
  PluginBrowserRecordingEventHandler,
} from './contract/browser-recordings.js';

export const PLUGIN_BROWSER_RECORDING_EVENT_KINDS = Object.freeze([
  'browser_recording_started', 'browser_recording_stopped', 'browser_recording_reviewed',
  'browser_recording_learned', 'browser_recording_purged',
] as const);
/** `PluginBrowserRecordingEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginBrowserRecordingEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_BROWSER_RECORDING_EVENT_KINDS)[number], PluginBrowserRecordingEventKind>>;

export function isPluginBrowserRecordingEventKind(kind: unknown): kind is PluginBrowserRecordingEventKind {
  return typeof kind === 'string' && (PLUGIN_BROWSER_RECORDING_EVENT_KINDS as readonly string[]).includes(kind);
}

const kindOf = (event: BrowserRecordingEventName): PluginBrowserRecordingEventKind => `browser_recording_${event}`;

export const subscribePluginBrowserRecordingEvent = createPluginEventSubscriber<PluginBrowserRecordingEventKind, PluginBrowserRecordingEvent>({
  label: 'browser recording',
  kindOf: (ev: BusEvent) => (ev.kind === 'browser_recording' ? kindOf(ev.event) : null),
  translate(ev, pluginId) {
    if (ev.kind !== 'browser_recording' || !ev.ownerUserId) return null;
    const identity = todoEventAudience(pluginId, ev.ownerUserId);
    if (!identity) return null;
    return {
      identity,
      ev: Object.freeze({
        kind: kindOf(ev.event), profileId: ev.profileId, recordingId: ev.recordingId,
        recording: ev.recording ? browserRecordingView(ev.recording) : null,
        ...(ev.reason ? { reason: ev.reason } : {}), origin: Object.freeze({ ...ev.origin }),
      }),
    };
  },
});
