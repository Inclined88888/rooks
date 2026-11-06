'use client';

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { onAccountChange } from '@/lib/account-change';
import { loadLayout, saveLayout } from '@/lib/ui-layout-store';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_PREFS_SCOPE,
  readNotificationPrefs,
  writeNotificationPrefs,
  type NotificationPrefs,
} from '@/lib/notification-prefs';

/**
 * The feed's settings: ONE store for the document, read once and written from
 * here, that the bell (top bar), the widget and the settings block all render.
 *
 * Not a `useStoredLayout` per surface: each one read the row on its own, and a
 * read sent before a change but answered after it put the old value back on
 * every surface — the bell un-filtered itself a second after the click.
 *
 * `version` is what keeps an answer from overtaking a change. Every write and
 * every account change bumps it; a read whose starting version is no longer
 * the current one describes a row older than what is on screen, and is
 * dropped. `epoch` counts accounts only: a write queued under the previous one
 * must not leave with the next one's cookie.
 *
 * Other tabs pick the change up at their next read — the row lives on the
 * daemon, not in `localStorage`, so there is no `storage` event to follow.
 */

type State = {
  /** `null` until a read succeeds: the surfaces then show the defaults. */
  prefs: NotificationPrefs | null;
  /** The daemon has answered, even with a refusal. */
  known: boolean;
  /** A read succeeded: writing can no longer erase a row we never saw. */
  ready: boolean;
};

const INITIAL: State = { prefs: null, known: false, ready: false };

let state: State = INITIAL;
let version = 0;
let epoch = 0;
/** Version the read on the wire started at; `null` when none is. */
let reading: number | null = null;
/** Account the store's value belongs to; `undefined` before the first one is
 *  announced, which is the account the first read was sent with. */
let owner: string | null | undefined;
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function load(): void {
  if (reading === version) return;
  const startedAt = version;
  reading = startedAt;
  void loadLayout({ scope: NOTIFICATION_PREFS_SCOPE, storage: null }).then((out) => {
    if (reading === startedAt) reading = null;
    if (startedAt !== version) return;
    // A refusal answers without un-filtering anything: the value already on
    // screen stays, and the defaults stay read-only.
    set(out.ok
      ? { prefs: readNotificationPrefs(out.raw), known: true, ready: true }
      : { ...state, known: true });
  });
}

function reset(): void {
  version += 1;
  epoch += 1;
  reading = null;
  set(INITIAL);
  if (listeners.size > 0) load();
}

onAccountChange((next) => {
  if (owner !== undefined && owner !== next) reset();
  owner = next;
});

function setPrefs(next: NotificationPrefs): void {
  if (!state.ready) return;
  const prefs = readNotificationPrefs(next);
  version += 1;
  const at = epoch;
  set({ ...state, prefs });
  void saveLayout(writeNotificationPrefs(prefs), {
    scope: NOTIFICATION_PREFS_SCOPE,
    storage: null,
    fetchImpl: (input, init) => at === epoch
      ? fetch(input, init)
      : Promise.resolve(new Response(null, { status: 409 })),
  }).then((ok) => {
    if (ok || at !== epoch) return;
    toast.error(t('widgets.saveError'), { id: 'layout-save' });
    // What is on screen was not stored: show what is.
    load();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // A refused read is retried by the next surface that mounts.
  if (!state.ready) load();
  return () => { listeners.delete(listener); };
}

const snapshot = () => state;
const serverSnapshot = () => INITIAL;

/** Test hook: a fresh document. */
export function resetNotificationPrefsForTest(): void {
  version += 1;
  epoch += 1;
  reading = null;
  owner = undefined;
  state = INITIAL;
}

export function useNotificationPrefs(): {
  prefs: NotificationPrefs;
  /** The stored value has answered. */
  known: boolean;
  /** Writes are possible: the stored value was read. */
  ready: boolean;
  setPrefs: (next: NotificationPrefs) => void;
} {
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return { prefs: current.prefs ?? DEFAULT_NOTIFICATION_PREFS, known: current.known, ready: current.ready, setPrefs };
}
