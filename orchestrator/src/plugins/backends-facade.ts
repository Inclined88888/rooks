/**
 * `ctx.backends.list`: the LLM backends and models available right now — what
 * `GET /api/backends/catalog` and the `backends_list` tool answer, so a plugin
 * that creates agents (`ctx.agents.create`) picks a `backend` and a `model`
 * that exist instead of guessing.
 *
 * The catalogue is the one the CALLER would read: a request sees the
 * subscription accounts on its access list, a job — which has no account —
 * sees none (`catalogForViewer(null)`). Nothing here writes: registering a
 * backend is `ctx.backends.register` (`backends:register`).
 */
import type { DbViewer } from '../users/owned.js';
import type { PluginBackendCatalog } from './contract/backends.js';
export type { PluginBackendCatalog } from './contract/backends.js';

export type CatalogCallerScope = {
  /** The account of the request; `null` in a job. */
  viewer: DbViewer | null;
};

export type ScopedBackendCatalog = {
  list(): Promise<PluginBackendCatalog>;
};

export function backendCatalogFor(scope: CatalogCallerScope): ScopedBackendCatalog {
  return {
    async list() {
      const { catalogForViewer } = await import('../plugins-bundled/backends/account-routes.js');
      return catalogForViewer(scope.viewer);
    },
  };
}
