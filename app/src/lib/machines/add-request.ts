/**
 * "Add a machine…" in the switcher opens the settings pane with its form
 * already open. The pane may not be mounted yet: the wish waits here.
 */
let addRequested = false;
const addListeners = new Set<() => void>();

export function requestAddMachine(): void {
  addRequested = true;
  for (const listener of addListeners) listener();
}

/** True once per request: the pane that reads it opens its form. */
export function takeAddRequest(): boolean {
  const asked = addRequested;
  addRequested = false;
  return asked;
}

export function onAddRequest(listener: () => void): () => void {
  addListeners.add(listener);
  return () => { addListeners.delete(listener); };
}

/** Tests only: no wish pending. */
export function resetAddRequest(): void {
  addRequested = false;
}
