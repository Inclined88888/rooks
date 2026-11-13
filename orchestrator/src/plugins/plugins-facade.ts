/**
 * `ctx.plugins`: what is installed, and switching it on or off.
 *
 * `list` is the gallery's list through its visibility curtain: a request sees
 * the plugins its account may see, a job the whole installation. `setEnabled`
 * does what `POST /api/plugins/:id/enabled` does, through the same functions:
 *
 *  - a bundled module needs the `plugins:manage` right on the account;
 *  - a third-party plugin needs a superadmin, because switching one on runs its
 *    code with the operator's rights;
 *  - a job never switches anything: no human gesture stands behind it;
 *  - a plugin never switches ITSELF, so it cannot go back on what an operator
 *    decided by disabling it from the inside.
 *
 * Install, remove and verify stay with the operator (`rooks plugin`, the
 * gallery): this facade never loads new code.
 */
import { z } from 'zod';
import { LicenseCapabilityError } from '../license/capabilities.js';
import { CoreModuleError } from '../kernel/module-config.js';
import { filterGallery } from '../users/surfaces.js';
import {
  auditPluginAction, parseAdminInput, PluginAdminError, type AdminCallerScope,
} from './admin-support.js';
import type { PluginPublic } from './public.js';
import { galleryPlugins, loaderFromApp } from './runtime.js';
import { applyToggle, assertToggleMutable, resolveToggleTarget } from './toggle.js';
import { pluginCallerAllows } from './als.js';

import type { PluginInfo } from './contract/plugins.js';
export type { PluginInfo } from './contract/plugins.js';

export type ScopedPlugins = {
  list(): PluginInfo[];
  /** Switches a plugin or bundled module; `true` when it was applied. */
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
};

/** The Express app that carries the loader; resolved at call time (it mounts after the host). */
type AppStore = { get(key: string): unknown; set(key: string, value: unknown): unknown };
export type PluginsAdminDeps = { app(): AppStore | null };

const IdSchema = z.string().trim().min(1).max(200);
const EnabledSchema = z.boolean();

function view(p: PluginPublic): PluginInfo {
  return {
    id: p.id, version: p.version, source: p.source, tier: p.tier, wanted: p.wanted, kind: [...p.kind],
    label: p.label, description: p.description, author: p.author, signed: p.signed, builtin: p.builtin,
    state: p.state, reason: p.reason, route: p.route,
  };
}

export function pluginsAdminFor(scope: AdminCallerScope, deps: PluginsAdminDeps): ScopedPlugins {
  return {
    list() {
      const app = deps.app();
      const all = galleryPlugins(app ? loaderFromApp(app) : null);
      return (scope.job ? all : filterGallery(all, scope.viewer)).map(view);
    },
    async setEnabled(id, enabled) {
      const rawId = parseAdminInput(IdSchema, id);
      const wanted = parseAdminInput(EnabledSchema, enabled);
      if (scope.job) throw new PluginAdminError('forbidden', 'a plugin switches nothing on its own: this needs an account');
      const target = resolveToggleTarget(rawId);
      if (target.id === scope.pluginId) throw new PluginAdminError('forbidden', 'a plugin does not switch itself');
      try {
        assertToggleMutable(target);
      } catch (err) {
        if (err instanceof LicenseCapabilityError) throw new PluginAdminError('forbidden', err.message, err.code);
        throw err;
      }
      // A bundled module is Rooks's own code; a third-party one is the operator's call.
      const allowed = target.module ? pluginCallerAllows(scope.viewer, 'plugins:manage') : scope.superadmin;
      if (!allowed) {
        throw new PluginAdminError('forbidden', target.module
          ? 'switching a bundled module needs the plugins:manage right'
          : 'switching a third-party plugin is for a superadmin');
      }
      const app = deps.app();
      if (!app) throw new PluginAdminError('unavailable', 'the plugin loader is not running');
      let applied: boolean;
      try {
        applied = await applyToggle(app, target, wanted);
      } catch (err) {
        if (err instanceof CoreModuleError) throw new PluginAdminError('forbidden', err.message);
        throw err;
      }
      if (!applied) throw new PluginAdminError('not_found', `plugin not found: ${rawId}`);
      auditPluginAction(scope, wanted ? 'plugin.enable' : 'plugin.disable', `plugin:${target.id}`);
      return true;
    },
  };
}
