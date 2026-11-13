/**
 * `ctx.permissionSource` (API 15, sensitive permission
 * `accounts:permissions-source`): a signed plugin answers which rights an account
 * holds. See `users/permission-source.ts` for how the core uses the answer.
 */
import { PermissionSourceHeldError, registerPermissionSource } from '../users/permission-source.js';
import { permissionCatalog } from '../users/permission-catalog.js';
import { currentGallery } from './runtime.js';
import type { PluginPermissionCatalog, PluginPermissionSource, PluginPermissionSourceHandle } from './contract/accounts.js';

export class PermissionSourceError extends Error {
  constructor(public readonly code: 'not_trusted' | 'held' | 'invalid', message: string) {
    super(message);
    this.name = 'PermissionSourceError';
  }
}

export function createPermissionSourceFacade(opts: {
  pluginId: string;
  assertPermission: () => void;
  /** Signed or shipped with the product: rights never come from an unsigned plugin. */
  trusted: boolean;
  onUnload: (fn: () => void) => void;
}): PluginPermissionSource {
  let release: (() => void) | null = null;
  opts.onUnload(() => { release?.(); release = null; });
  return {
    register(fn: (userId: string) => readonly string[]): PluginPermissionSourceHandle {
      opts.assertPermission();
      if (!opts.trusted) throw new PermissionSourceError('not_trusted', `plugin \`${opts.pluginId}\` is not signed: it cannot provide rights`);
      if (typeof fn !== 'function') throw new PermissionSourceError('invalid', 'the source is a function of an account id');
      let handle;
      try {
        handle = registerPermissionSource(opts.pluginId, fn);
      } catch (err) {
        if (err instanceof PermissionSourceHeldError) throw new PermissionSourceError('held', err.message);
        throw err;
      }
      release = handle.release;
      return { invalidate: (userId?: string) => handle.invalidate(userId) };
    },
    catalog(): PluginPermissionCatalog {
      opts.assertPermission();
      if (!opts.trusted) throw new PermissionSourceError('not_trusted', `plugin \`${opts.pluginId}\` is not signed: it cannot provide rights`);
      // The catalogue lists the checks the core runs: it stays in the core,
      // and the source that grants rights reads it from here.
      return permissionCatalog(currentGallery());
    },
  };
}
