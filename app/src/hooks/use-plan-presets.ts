'use client';

import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { onAccountChange } from '@/lib/account-change';
import {
  readPlanPresets, removePlanPreset, renamePlanPreset, upsertPlanPreset,
  type PlanPreset, type PlanPresetRoles,
} from '@/lib/plan-presets';

/**
 * The signed-in account's series-planner model presets (`lib/plan-presets.ts`):
 * ONE store for the document, read once from `GET /api/ui/prefs/plan-presets`.
 * The list is the account's, on the daemon (`user_prefs`), so it follows the
 * account from one machine to the next.
 *
 * Same store as `use-model-favorites.ts`, for the same reasons: writes are
 * optimistic and send the whole list with `PUT`, one after the other; a
 * refusal puts back the list that was on screen (or re-reads when another
 * change has happened since); `version` drops a read older than a change,
 * `epoch` keeps a write queued under the previous account from leaving with
 * the next one's cookie.
 */

type State = {
  presets: readonly PlanPreset[];
  /** A read succeeded: writing can no longer erase a list we never saw. */
  ready: boolean;
};

const ENDPOINT = '/api/ui/prefs/plan-presets';
const INITIAL: State = { presets: [], ready: false };

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

function load(): void {
  if (reading === version) return;
  const startedAt = version;
  const at = epoch;
  reading = startedAt;
  void fetch(ENDPOINT, { cache: 'no-store' })
    .then(async (r) => (r.ok ? readPlanPresets(await r.json()) : null))
    .catch(() => null)
    .then((presets) => {
      if (reading === startedAt) reading = null;
      if (startedAt !== version || at !== epoch) return;
      // A refusal leaves the presets on screen as they are, and read-only.
      if (presets) set({ presets, ready: true });
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

/** Send the whole list; the daemon's answer (its dates, its deduplication) becomes the list. */
function write(presets: PlanPreset[]): void {
  const previous = state.presets;
  version += 1;
  const mine = version;
  const at = epoch;
  set({ ...state, presets });
  queue = queue.then(async () => {
    if (at !== epoch) return;
    let stored: PlanPreset[] | null = null;
    try {
      const r = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presets: presets.map(({ id, name, roles }) => ({ id, name, roles })) }),
      });
      stored = r.ok ? readPlanPresets(await r.json()) : null;
    } catch {
      stored = null;
    }
    if (at !== epoch) return;
    if (stored) {
      if (mine === version) set({ ...state, presets: stored });
      return;
    }
    toast.error(t('taskForm.seriesPlan.presets.saveError'), { id: 'plan-presets-save' });
    if (mine === version) set({ ...state, presets: previous });
    else load();
  });
}

function newPresetId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Save `roles` under `name`, replacing a preset of the same name (without
 * case). False when nothing is sent: the list is not read yet, the name is
 * empty or too long, no role is set, or the ceiling is reached.
 */
export function savePlanPreset(name: string, roles: PlanPresetRoles): boolean {
  if (!state.ready) return false;
  const next = upsertPlanPreset(state.presets, name, roles, newPresetId);
  if (!next) return false;
  write(next);
  return true;
}

/** False when nothing is sent: list not read yet, invalid name, unknown id, or a name another preset has. */
export function renamePlanPresetById(id: string, name: string): boolean {
  if (!state.ready) return false;
  const next = renamePlanPreset(state.presets, id, name);
  if (!next) return false;
  write(next);
  return true;
}

export function removePlanPresetById(id: string): void {
  if (!state.ready || !state.presets.some((preset) => preset.id === id)) return;
  write(removePlanPreset(state.presets, id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // A refused read is retried by the next form that mounts.
  if (!state.ready) load();
  return () => { listeners.delete(listener); };
}

const snapshot = () => state;
const serverSnapshot = () => INITIAL;

/** The store outside React (tests, and a caller that only reads). */
export const planPresetsStore = { subscribe, snapshot };

/** Test hook: a fresh document. */
export function resetPlanPresetsForTest(): void {
  version += 1;
  epoch += 1;
  reading = null;
  owner = undefined;
  queue = Promise.resolve();
  listeners.clear();
  state = INITIAL;
}

/** Resolves once every queued write has been answered (tests). */
export function planPresetsSettled(): Promise<void> {
  return queue;
}

export function usePlanPresets(): {
  /** The stored order. May name accounts or models the catalogue no longer lists: `presetPairsFor` sorts them out. */
  presets: readonly PlanPreset[];
  /** The stored list has been read; until then nothing can be saved. */
  ready: boolean;
  save: (name: string, roles: PlanPresetRoles) => boolean;
  rename: (id: string, name: string) => boolean;
  remove: (id: string) => void;
} {
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return {
    presets: current.presets,
    ready: current.ready,
    save: savePlanPreset,
    rename: renamePlanPresetById,
    remove: removePlanPresetById,
  };
}
