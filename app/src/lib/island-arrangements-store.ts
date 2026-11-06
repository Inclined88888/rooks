/**
 * The account's named island arrangements, held once for the document.
 *
 * A module store rather than `useStoredLayout`, because two readers are not
 * React components: the layout plugin registers one menu entry per
 * arrangement shown in the menu (`plugins-client/ui-layout.tsx`), outside any
 * render. The menu section and the page read the same store, so a rename in
 * one repaints the other.
 *
 * Every write reads the row again first and is guarded by the version it read
 * (`expected=` of `PUT /api/layout`): the list is short and edited rarely,
 * but from any window, and the one left on an old copy must not erase what
 * another one saved.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { onAccountChange, currentAccount } from './account-change';
import {
  fitsArrangements,
  readArrangements,
  writeArrangements,
  type ArrangementError,
  type ArrangementResult,
  type IslandArrangement,
} from './island-arrangements';
import { loadLayout, storeLayout } from './ui-layout-store';
import { sharedArrangementsScope } from './workspace-scope';

export type ArrangementsState = {
  owner: string | null;
  /** The list was read once for this account. Before that, nothing may be written. */
  ready: boolean;
  arrangements: readonly IslandArrangement[];
};

export type ArrangementOutcome =
  | { ok: true; arrangement: IslandArrangement }
  | { ok: false; error: ArrangementError };

let state: ArrangementsState = { owner: null, ready: false, arrangements: [] };
/** Bumped at every change of account: an answer read for the previous one lands nowhere. */
let epoch = 0;
const listeners = new Set<() => void>();

function publish(next: ArrangementsState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function arrangementsState(): ArrangementsState {
  return state;
}

export function subscribeArrangements(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Reads the list of the current account. `false` when the daemon did not answer. */
export async function refreshArrangements(): Promise<boolean> {
  const { owner } = state;
  if (!owner) return false;
  const started = epoch;
  const out = await loadLayout({ scope: await sharedArrangementsScope(owner), storage: null });
  if (started !== epoch || !out.ok) return false;
  publish({ owner, ready: true, arrangements: readArrangements(out.raw) });
  return true;
}

/**
 * Points the store at `owner`. Another account empties the list before its
 * own is read: one account's arrangements must never show in the next one's
 * menu, not even for the length of a request.
 */
export function followArrangementsOwner(owner: string | null): void {
  if (owner === state.owner) return;
  epoch++;
  publish({ owner, ready: false, arrangements: [] });
  if (owner) void refreshArrangements();
}

/**
 * Follows the account the document is signed in as, until the returned
 * function is called. For a reader outside React (the menu entries).
 */
export function followAccountArrangements(): () => void {
  followArrangementsOwner(currentAccount());
  return onAccountChange(followArrangementsOwner);
}

/**
 * Applies `op` to the list as the daemon holds it NOW, then writes it.
 *
 * The verdict is the daemon's, awaited: a caller closes its form or announces
 * a success on `ok` only (the rule of `commitPresets`). A write refused
 * because another window wrote in between is tried once more on the fresh
 * list — the operation is a name and an id, so it still means the same.
 */
export async function mutateArrangements(op: (current: readonly IslandArrangement[]) => ArrangementResult): Promise<ArrangementOutcome> {
  const { owner } = state;
  if (!owner) return { ok: false, error: 'write-failed' };
  const started = epoch;
  const scope = await sharedArrangementsScope(owner);
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await loadLayout({ scope, storage: null });
    if (started !== epoch || !read.ok) return { ok: false, error: 'write-failed' };
    const result = op(readArrangements(read.raw));
    if (!result.ok) return result;
    if (!fitsArrangements(result.arrangements)) return { ok: false, error: 'too-large' };
    const written = await storeLayout(writeArrangements(result.arrangements), {
      scope,
      storage: null,
      version: { value: read.updatedAt },
    });
    if (started !== epoch) return { ok: false, error: 'write-failed' };
    if (written === 'ok') {
      publish({ owner, ready: true, arrangements: result.arrangements });
      return { ok: true, arrangement: result.arrangement };
    }
    if (written === 'failed') return { ok: false, error: 'write-failed' };
  }
  return { ok: false, error: 'write-failed' };
}

const serverState: ArrangementsState = { owner: null, ready: false, arrangements: [] };

/**
 * The arrangements of `owner`, read when a reader mounts — the menu is opened
 * rarely, and a list edited in another window must show up there.
 */
export function useArrangements(owner: string | null): ArrangementsState {
  useEffect(() => {
    // An owner not resolved yet says nothing about the account: following it
    // would empty a list another reader is showing.
    if (!owner) return;
    if (owner !== arrangementsState().owner) followArrangementsOwner(owner);
    else void refreshArrangements();
  }, [owner]);
  const current = useSyncExternalStore(subscribeArrangements, arrangementsState, () => serverState);
  return current.owner === owner ? current : serverState;
}

/**
 * The name of an arrangement, from the list already held — no read of its
 * own: the island workspace asks on every page, and the layout plugin keeps
 * the list read for the menu entries anyway.
 */
export function useArrangementName(id: string | null): string | null {
  const current = useSyncExternalStore(subscribeArrangements, arrangementsState, () => serverState);
  return id ? current.arrangements.find((a) => a.id === id)?.name ?? null : null;
}
