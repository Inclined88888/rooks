/**
 * Where the booted kernel's reconciler hangs: on the Express app, read at each
 * request. Extracted verbatim from `bundled-reload.ts`.
 */
export type BundledReconciler = {
  /**
   * Re-reads the config from disk and brings the tree in line with it.
   * Returns the ids whose decision actually moved — empty when the write did
   * not touch `modules`, which is what keeps an unrelated config save from
   * remounting the world.
   */
  reconcile(): Promise<string[]>;
  /** Polls `timon.config.json` so `timon module enable|disable` is hot too. */
  watch(intervalMs?: number): () => void;
  dispose(): void;
};

const KEY = 'timon.bundledReconciler';

/** Express `Application` and a router's `req.app` do not share a type. */
type AppStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): unknown;
};

export function attachBundledReconciler(app: AppStore, reconciler: BundledReconciler): void {
  app.set(KEY, reconciler);
}

/**
 * `null` outside a booted kernel — the routes are also mounted by tests and by
 * a CLI-only install, where writing the config IS the whole operation.
 */
export function reconcilerFromApp(app: AppStore): BundledReconciler | null {
  const value: unknown = app.get(KEY);
  return value ? (value as BundledReconciler) : null;
}
