/**
 * The account this document is signed in as, announced by
 * `WorkspaceLayoutProvider` each time it drops its per-account memory (on the
 * login page, and when a resolved route names another owner).
 *
 * A module store that keeps a value read from the daemon outlives the account
 * it was read for: it subscribes here and empties itself when the owner
 * changes, as `forgetStoredLayouts` does for the layout seeds.
 */

type Listener = (owner: string | null) => void;

const listeners = new Set<Listener>();
/** The last account announced: a store that subscribes after the announcement still learns it. */
let announced: string | null = null;

export function currentAccount(): string | null {
  return announced;
}

export function onAccountChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function announceAccount(owner: string | null): void {
  announced = owner;
  for (const listener of listeners) listener(owner);
}
