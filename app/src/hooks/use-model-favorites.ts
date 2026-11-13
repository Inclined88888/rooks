'use client';

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { onAccountChange } from '@/lib/account-change';
import type { BackendName } from '@/lib/backends';

/**
 * The signed-in account's favourite models (`docs/MODEL-PICKER.md`): ONE store
 * for the document, read once from `GET /api/ui/prefs/model-favorites`, that
 * every mounted ModelPicker renders — a star set in the composer lights up in
 * the Kanban form without a second read.
 *
 * A favourite is the exact `(backend, model)` pair, account instance included
 * (`claude@<id>`). The list is the account's, on the daemon (`user_prefs`), so
 * it follows the account from one machine to the next.
 *
 * Writes are optimistic: the star turns at once, the whole ordered list goes
 * out with `PUT`, and a refusal puts back the list that was on screen before
 * (or re-reads when another change has happened since). PUTs leave one after
 * the other: two quick stars must not land in the reverse order.
 *
 * `version` and `epoch` follow `use-notification-prefs.ts`: a read that
 * started before a change describes an older list and is dropped; a write
 * queued under the previous account never leaves with the next one's cookie.
 */

export type ModelFavorite = { backend: BackendName; model: string };

type State = {
  favorites: readonly ModelFavorite[];
  /** A read succeeded: writing can no longer erase a list we never saw. */
  ready: boolean;
};

const ENDPOINT = '/api/ui/prefs/model-favorites';
const INITIAL: State = { favorites: [], ready: false };

let state: State = INITIAL;
let version = 0;
let epoch = 0;
let reading: number | null = null;
let owner: string | null | undefined;
let queue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Same pair, compared exactly: the account is part of the favourite. */
export function sameModel(a: ModelFavorite, b: ModelFavorite): boolean {
  return a.backend === b.backend && a.model === b.model;
}

function readList(raw: unknown): ModelFavorite[] {
  const list = (raw as { favorites?: unknown } | null)?.favorites;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is ModelFavorite =>
    !!item && typeof (item as ModelFavorite).backend === 'string' && typeof (item as ModelFavorite).model === 'string');
}

function load(): void {
  if (reading === version) return;
  const startedAt = version;
  const at = epoch;
  reading = startedAt;
  void fetch(ENDPOINT, { cache: 'no-store' })
    .then(async (r) => (r.ok ? readList(await r.json()) : null))
    .catch(() => null)
    .then((favorites) => {
      if (reading === startedAt) reading = null;
      if (startedAt !== version || at !== epoch) return;
      // A refusal leaves the stars on screen as they are, and read-only.
      if (favorites) set({ favorites, ready: true });
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

/** Replace the whole ordered list. Ignored until the stored list has been read. */
export function setModelFavorites(next: readonly ModelFavorite[]): void {
  if (!state.ready) return;
  const previous = state.favorites;
  const favorites = next.map(({ backend, model }) => ({ backend, model }));
  version += 1;
  const mine = version;
  const at = epoch;
  set({ ...state, favorites });
  queue = queue.then(async () => {
    if (at !== epoch) return;
    let stored: ModelFavorite[] | null = null;
    try {
      const r = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ favorites }),
      });
      stored = r.ok ? readList(await r.json()) : null;
    } catch {
      stored = null;
    }
    if (at !== epoch) return;
    if (stored) {
      // The daemon's own order and deduplication, unless a later star is already on screen.
      if (mine === version) set({ ...state, favorites: stored });
      return;
    }
    toast.error(t('modelPicker.favoriteError'), { id: 'model-favorites-save' });
    if (mine === version) set({ ...state, favorites: previous });
    else load();
  });
}

/** Star or unstar one pair; a new star goes to the end of the list. */
export function toggleModelFavorite(pick: ModelFavorite): void {
  const list = state.favorites;
  setModelFavorites(list.some((fav) => sameModel(fav, pick))
    ? list.filter((fav) => !sameModel(fav, pick))
    : [...list, pick]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // A refused read is retried by the next picker that mounts.
  if (!state.ready) load();
  return () => { listeners.delete(listener); };
}

const snapshot = () => state;
const serverSnapshot = () => INITIAL;

/** Test hook: a fresh document. */
export function resetModelFavoritesForTest(): void {
  version += 1;
  epoch += 1;
  reading = null;
  owner = undefined;
  queue = Promise.resolve();
  state = INITIAL;
}

/** Resolves once every queued write has been answered (tests). */
export function modelFavoritesSettled(): Promise<void> {
  return queue;
}

export function useModelFavorites(): {
  /** The stored order. May name accounts or models the catalogue no longer lists: the picker hides those. */
  favorites: readonly ModelFavorite[];
  /** The stored list has been read; until then stars are shown off and do nothing. */
  ready: boolean;
  isFavorite: (pick: ModelFavorite) => boolean;
  toggle: (pick: ModelFavorite) => void;
  setFavorites: (next: readonly ModelFavorite[]) => void;
} {
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return {
    favorites: current.favorites,
    ready: current.ready,
    isFavorite: (pick) => current.favorites.some((fav) => sameModel(fav, pick)),
    toggle: toggleModelFavorite,
    setFavorites: setModelFavorites,
  };
}
