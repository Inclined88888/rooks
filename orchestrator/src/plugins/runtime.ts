/**
 * Hooks the plugin loader onto the Express app — one instance per daemon,
 * read again on each request.
 *
 * The loader is created AFTER the bundled modules (their facades must already
 * be running). The routes of `@timon/plugins`, on the other hand, are mounted before. So the
 * loader cannot be closed over in `apply`: it is set on the app, and
 * each request reads it again. `app.set` is per instance — two tests, two
 * daemons, no global state stepping on itself.
 */
import { bundledModuleRows } from '../kernel/capabilities.js';
import type { PluginLoader } from './loader.js';
import { toPublicBundled, toPublicPlugin, type PluginPublic } from './public.js';

const KEY = 'timon.pluginLoader';

/** Express `Application` and the routers' `req.app` do not have the same type. */
type AppStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): unknown;
};

export function attachPluginLoader(app: AppStore, loader: PluginLoader): void {
  app.set(KEY, loader);
}

export function detachPluginLoader(app: AppStore): void {
  app.set(KEY, undefined);
}

export function loaderFromApp(app: AppStore): PluginLoader | null {
  const value: unknown = app.get(KEY);
  return value ? (value as PluginLoader) : null;
}

export function publicPlugins(loader: PluginLoader): PluginPublic[] {
  return loader.list().map((s) => toPublicPlugin(s, loader.bundles, loader.covers));
}

/**
 * Everything that is a plugin on this machine: the bundled modules of the
 * product, then the third-party packages (plan §10.12). The gallery reads this
 * list, and only an installation with neither shows an empty state.
 *
 * Bundled first, and an id it already holds wins: a package installed under
 * `~/.timon/plugins/` must not be able to shadow `@timon/db` in the gallery by
 * claiming its id.
 */
export function galleryPlugins(loader: PluginLoader | null): PluginPublic[] {
  const bundled = bundledModuleRows().map(toPublicBundled);
  const taken = new Set(bundled.map((p) => p.id));
  const third = loader ? publicPlugins(loader).filter((p) => !taken.has(p.id)) : [];
  return [...bundled, ...third];
}

let gallerySource: (() => PluginPublic[]) | null = null;

/**
 * The plugin list for a caller that has no request (`ctx.layout`): the daemon
 * sets it where it attaches the loader, a test sets its own. Without one, the
 * bundled modules alone — never a throw, never a stale loader.
 */
export function setGallerySource(source: (() => PluginPublic[]) | null): void {
  gallerySource = source;
}

export function currentGallery(): PluginPublic[] {
  return gallerySource ? gallerySource() : galleryPlugins(null);
}
