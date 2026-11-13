'use client';

/**
 * The manifest permissions of each loaded plugin, as the browser half of the
 * product reads them.
 *
 * Most permissions are enforced by the daemon, on the plugin's own routes. A
 * few guard something that only exists in this page — `browser:control` gates
 * the `command()` a `browser.toolbar` / `browser.drawer` occupant receives,
 * which goes through the user's session, where the daemon cannot tell a
 * plugin's call from the product's; `dictation:engine` gates the engines the
 * product hands the microphone's samples to. Those are checked here, against the
 * identity of the slot entry (`SlotEntry.pluginId`), never against anything
 * the plugin says about itself at render time.
 *
 * A grant lives as long as the load that made it: the loader grants a
 * third-party half its manifest permissions, `mountBundledClients` a bundled
 * half the ones its `BundledClientPlugin` declares, and both take them back
 * on dispose. A plugin nobody granted holds nothing.
 */

/** Browser-only permissions; the daemon's list lives in `orchestrator/src/plugins/manifest.ts`. */
export const BROWSER_CONTROL_PERMISSION = 'browser:control';
/**
 * The daemon's own read permission of the annotations (`ctx.browserAnnotations`),
 * honoured by `useBrowserAnnotations()` too: the list and the details hold what
 * the page showed, so a browser occupant reads them only with this or
 * `browser:control` (TODO #475).
 */
export const BROWSER_ANNOTATIONS_READ_PERMISSION = 'browser:annotations:read';
/**
 * Registering a speech-to-text engine (`dictation.engine`, API 14): it hears
 * the user's voice. Sensitive on the daemon side; checked here, at
 * `register`, and again each time the product picks an engine — a grant
 * taken back at uninstall takes the engine out of the route at once.
 */
export const DICTATION_ENGINE_PERMISSION = 'dictation:engine';

const grants = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let version = 0;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: a grant that lands after an entry painted re-renders it. */
export function subscribeClientPermissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clientPermissionsVersion(): number {
  return version;
}

/**
 * Records what `pluginId` declared, until the returned dispose runs. A later
 * grant for the same id replaces it (a reload), and the earlier dispose then
 * leaves the newer grant alone.
 */
export function grantClientPermissions(pluginId: string, permissions: readonly string[]): () => void {
  const granted: ReadonlySet<string> = new Set(permissions);
  grants.set(pluginId, granted);
  publish();
  return () => {
    if (grants.get(pluginId) !== granted) return;
    grants.delete(pluginId);
    publish();
  };
}

export function clientPluginHolds(pluginId: string | null, permission: string): boolean {
  return pluginId !== null && grants.get(pluginId)?.has(permission) === true;
}

export function resetClientPermissionsForTests(): void {
  grants.clear();
  publish();
}
