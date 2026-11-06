/**
 * `ctx.license`: the edition of this installation, nothing else.
 *
 * Read-only on purpose. How a licence is activated, installed, refreshed or
 * removed stays inside `license/`: no key, token, plan, machine name or expiry
 * comes out of here, and there is no `license_changed` event for plugins.
 */
import { capabilitiesPayload } from '../kernel/capabilities.js';
import type { AdminCallerScope } from './admin-support.js';

import type { PluginEdition } from './contract/edition.js';
export type { PluginEdition } from './contract/edition.js';

export type ScopedLicense = { edition(): PluginEdition };

export function licenseFor(_scope: AdminCallerScope): ScopedLicense {
  return {
    edition() {
      return capabilitiesPayload().edition === 'expert' ? 'expert' : 'lite';
    },
  };
}
