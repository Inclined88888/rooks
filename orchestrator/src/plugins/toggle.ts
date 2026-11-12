/**
 * The switch of a plugin or a bundled module, without the HTTP around it.
 *
 * `POST /api/plugins/:id/enabled` and `ctx.plugins.setEnabled` do the same
 * thing in the same order; only who may do it differs, and each caller checks
 * that itself between `assertToggleMutable` and `applyToggle`. Extracted
 * verbatim from the route.
 */
import { reconcilerFromApp } from '../kernel/bundled-reconciler.js';
import { CATALOG } from '../kernel/catalog.js';
import { canonicalModuleId } from '../kernel/legacy-ids.js';
import { setModuleEnabled } from '../kernel/module-config.js';
import { assertCompositionMutable } from '../license/capabilities.js';
import { licenseState } from '../license/runtime.js';
import { resolveBuiltins } from './builtin.js';
import { builtinNamed, setPluginEnabled } from './install.js';
import { loaderFromApp } from './runtime.js';

type AppStore = { get(key: string): unknown; set(key: string, value: unknown): unknown };

export type ToggleTarget = {
  id: string;
  /** A bundled module (`config.modules[id]`) rather than a third-party package. */
  module: boolean;
};

/**
 * Id as requested, otherwise its current id if it names a module of the
 * catalogue. The raw id comes first: a third-party package that would be called
 * `telegram` must not be diverted to `@rooks/telegram`.
 */
export function resolveId(raw: string): string {
  if (CATALOG.some((m) => m.id === raw)) return raw;
  const canonical = canonicalModuleId(raw);
  return CATALOG.some((m) => m.id === canonical) ? canonical : raw;
}

export function resolveToggleTarget(raw: string): ToggleTarget {
  const id = resolveId(raw);
  return { id, module: CATALOG.some((m) => m.id === id) };
}

/**
 * A built-in stays switchable under a fixed composition (cf. setPluginEnabled);
 * a bundled module or an installed plugin does not. Throws `LicenseCapabilityError`.
 */
export function assertToggleMutable(target: ToggleTarget): void {
  const builtin = !target.module && builtinNamed(target.id, resolveBuiltins()) !== null;
  if (!builtin) assertCompositionMutable(licenseState());
}

/**
 * Writes the wish into `rooks.config.json` and recomposes. `false` when the id
 * names no installed third-party plugin; a bundled module that cannot be
 * switched off throws `CoreModuleError`.
 */
export async function applyToggle(app: AppStore, target: ToggleTarget, enabled: boolean): Promise<boolean> {
  // A bundled module is toggled in `modules[<id>]`, not in `plugins[<id>]`
  // — exactly what the lite preset writes. The loader does not know it;
  // looking there first answered 404 on a bundled module, and the gallery had
  // no usable toggle for half of the product.
  if (target.module) {
    // The tier is judged by `setModuleEnabled`, not read again here: the route and
    // `rooks module disable` then refuse the same core, by construction.
    setModuleEnabled(target.id, enabled);
    // Recomposition BEFORE the response: the gallery reads `/api/plugins` again
    // right away, and answering earlier would make it show the previous state. The
    // config watcher stays the CLI's path, which has no request to hold.
    // Missing outside the core (tests, install without a daemon): writing the config IS
    // the operation, and a toggle must not 500 because of it.
    try {
      await reconcilerFromApp(app)?.reconcile();
    } catch (err) {
      console.warn(`[plugins] ${target.id} : live recomposition impossible — ${(err as Error).message}`);
    }
    return true;
  }
  const known = loaderFromApp(app)?.list().some((p) => p.id === target.id) ?? false;
  if (!known) return false;
  setPluginEnabled(target.id, enabled);
  return true;
}
