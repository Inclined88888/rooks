/**
 * `ctx.modules`: the bundled modules of this installation and what the kernel
 * does with each, as the gallery shows it. Read-only: switching one is
 * `ctx.plugins.setEnabled`.
 */
import { bundledModuleRows } from '../kernel/capabilities.js';
import type { AdminCallerScope } from './admin-support.js';

import type { PluginModuleInfo } from './contract/modules.js';
export type { PluginModuleInfo } from './contract/modules.js';

export type ScopedModules = { list(): PluginModuleInfo[] };

export function modulesFor(_scope: AdminCallerScope): ScopedModules {
  return {
    list() {
      return bundledModuleRows().map((m) => ({
        id: m.id, tier: m.tier, active: m.active, reason: m.reason, missing: [...m.missing], wanted: m.wanted,
      }));
    },
  };
}
