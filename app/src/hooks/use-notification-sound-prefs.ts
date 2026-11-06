'use client';

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { onAccountChange } from '@/lib/account-change';
import { loadLayout, saveLayout } from '@/lib/ui-layout-store';
import {
  DEFAULT_NOTIFICATION_SOUND_PREFS,
  NOTIFICATION_SOUNDS_SCOPE,
  readNotificationSoundPrefs,
  writeNotificationSoundPrefs,
  type NotificationSoundPrefs,
} from '@/lib/notification-sounds';

/**
 * The sound settings: ONE store for the document, read by the settings block
 * and by the behavior that plays the sounds outside React. Same shape, and
 * same reasons, as `use-notification-prefs.ts`: `version` keeps a late read
 * from overtaking a change, `epoch` keeps a write from leaving with the next
 * account's cookie.
 */

type State = {
  prefs: NotificationSoundPrefs | null;
  /** The daemon has answered, even with a refusal. */
  known: boolean;
  /** A read succeeded: writing can no longer erase a row we never saw. */
  ready: boolean;
};

const INITIAL: State = { prefs: null, known: false, ready: false };

let state: State = INITIAL;
let version = 0;
let epoch = 0;
let reading: number | null = null;
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
  void loadLayout({ scope: NOTIFICATION_SOUNDS_SCOPE, storage: null }).then((out) => {
    if (reading === startedAt) reading = null;
    if (startedAt !== version) return;
    set(out.ok
      ? { prefs: readNotificationSoundPrefs(out.raw), known: true, ready: true }
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

function setPrefs(next: NotificationSoundPrefs): void {
  if (!state.ready) return;
  const prefs = readNotificationSoundPrefs(next);
  version += 1;
  const at = epoch;
  set({ ...state, prefs });
  void saveLayout(writeNotificationSoundPrefs(prefs), {
    scope: NOTIFICATION_SOUNDS_SCOPE,
    storage: null,
    fetchImpl: (input, init) => at === epoch
      ? fetch(input, init)
      : Promise.resolve(new Response(null, { status: 409 })),
  }).then((ok) => {
    if (ok || at !== epoch) return;
    toast.error(t('widgets.saveError'), { id: 'layout-save' });
    load();
  });
}

export function subscribeNotificationSoundPrefs(listener: () => void): () => void {
  listeners.add(listener);
  if (!state.ready) load();
  return () => { listeners.delete(listener); };
}

/**
 * What the behavior plays with: `null` until the daemon has answered, so a
 * user who switched the sounds off never hears one while the page loads.
 * A refused read answers the defaults.
 */
export function currentNotificationSoundPrefs(): NotificationSoundPrefs | null {
  if (!state.known) return null;
  return state.prefs ?? DEFAULT_NOTIFICATION_SOUND_PREFS;
}

const snapshot = () => state;
const serverSnapshot = () => INITIAL;

/** Test hook: a fresh document. */
export function resetNotificationSoundPrefsForTest(): void {
  version += 1;
  epoch += 1;
  reading = null;
  owner = undefined;
  state = INITIAL;
}

export function useNotificationSoundPrefs(): {
  prefs: NotificationSoundPrefs;
  known: boolean;
  ready: boolean;
  setPrefs: (next: NotificationSoundPrefs) => void;
} {
  const current = useSyncExternalStore(subscribeNotificationSoundPrefs, snapshot, serverSnapshot);
  return {
    prefs: current.prefs ?? DEFAULT_NOTIFICATION_SOUND_PREFS,
    known: current.known,
    ready: current.ready,
    setPrefs,
  };
}
