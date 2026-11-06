/**
 * Hot enable/disable of the BUNDLED modules — the counterpart of
 * `PluginLoader.update()` for the catalog side of the tree.
 *
 * Third-party plugins have been hot since P.3: the loader watches
 * `timon.config.json`, recomposes, and announces itself over SSE. Bundled
 * modules were not, for no deeper reason than nobody having wired it —
 * `boot.ts` called `ctx.loader.create()` once and never spoke to the loader
 * again. Toggling a module off wrote the config and waited for a restart that
 * only the user can perform. `registry.ts` already stated the intent it took this
 * file to honour: "disabled entries are kept: re-enabling a
 * module must be a hot toggle, not a restart."
 *
 * What makes it possible without any new machinery: a disabled loader entry is
 * kept in the tree, `ctx.loader.update(id, { disabled })` disposes or re-inits
 * its fiber, and `ctx.http.router()` is already reversible — a disposed module
 * leaves an inert shell behind, so its routes stop answering.
 *
 * What stays cold, deliberately (plan §11): everything in the config that is
 * NOT `modules`. This reconciler merges the `modules` section over the
 * in-process configuration and touches nothing else, so a stale or half-typed
 * edit elsewhere in the file cannot go live behind a module toggle.
 *
 * The licence is the one exception, added when the activation routes learned
 * to call `reconcile()` themselves (lic-6): `run()` reads `licenseState()`
 * fresh every time, through the same `licensedModulesOf` boot uses, so a
 * `PUT /api/license` (or `/activate`) lights up its modules without a
 * restart, the same way a config edit already did.
 *
 * Not to be confused with HMR: this reloads CONFIGURATION, never code. A
 * module whose source changed still needs `cordis-plugin-hmr` (dev only).
 */
import { unwatchFile, watchFile } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { CONFIG_FILE, config, loadConfig, setConfig } from '../config/load.js';
import { effectiveEdition } from '../license/license.js';
import { licenseState } from '../license/runtime.js';
import { setLiveDecisions } from './capabilities.js';
import type { BundledReconciler } from './bundled-reconciler.js';
import { licensedModulesOf, planEntries, type EntryDecision, type ModuleDescriptor } from './registry.js';

export type BundledReconcilerOptions = {
  catalog: readonly ModuleDescriptor[];
  /** Host capabilities as the boot resolved them — the machine has not changed. */
  capabilities: readonly string[];
  decisions: readonly EntryDecision[];
  /** Called once per reconciliation that changed something. */
  onChange?: (changed: string[]) => void;
};

/** True when two decisions ask the loader for a different tree. */
function differs(a: EntryDecision, b: EntryDecision): boolean {
  return a.disabled !== b.disabled || JSON.stringify(a.config) !== JSON.stringify(b.config);
}

export function createBundledReconciler(ctx: Context, opts: BundledReconcilerOptions): BundledReconciler {
  let current: EntryDecision[] = [...opts.decisions];
  let queue: Promise<string[]> = Promise.resolve([]);
  let watching = false;
  let disposed = false;
  let pending: NodeJS.Timeout | null = null;
  let listener: (() => void) | null = null;

  async function run(): Promise<string[]> {
    if (disposed) return [];
    let onDisk;
    try {
      onDisk = loadConfig();
    } catch (err) {
      // An invalid file leaves the last good tree in place, exactly like dsh's
      // `patchReload: live`. Tearing modules down over a typo would be worse
      // than ignoring the save.
      console.warn('[kernel] unreadable configuration, tree unchanged:', (err as Error).message);
      return [];
    }

    // Narrow merge, never a wholesale replacement: `config()` is read by auth,
    // the backends, the doctor and the UI, and only `modules` (from disk) and
    // the licence (from `licenseState()`) are meant to be live (plan §11 plus
    // lic-6). `config().edition` itself is still the raw configured value —
    // `effectiveEdition` resolves it against the licence right here, exactly
    // as the boot does, instead of trusting a value some other reader already
    // resolved.
    setConfig({ ...config(), modules: onDisk.modules });
    const license = licenseState();
    const licensed = licensedModulesOf(opts.catalog, license.modules);
    const edition = effectiveEdition(config().edition, license.edition);
    const next = planEntries(opts.catalog, {
      config: config(),
      capabilities: opts.capabilities,
      licensed,
    });

    const before = new Map(current.map((d) => [d.id, d]));
    const changed = next.filter((d) => {
      const previous = before.get(d.id);
      return previous ? differs(previous, d) : true;
    });
    current = next;
    // Set even without a tier change: `/api/capabilities` and the gallery
    // read the REAL state, and a reason that moves (licence, capability) must show
    // there. It is an assignment, not a recomposition.
    setLiveDecisions(next, [...opts.capabilities], edition);
    if (!changed.length) return [];

    for (const decision of changed) {
      if (disposed) return [];
      // A `clientOnly` module (ui-layout) has no fiber: its toggle lives
      // entirely in the capabilities, which the front just received.
      if (decision.clientOnly) continue;
      try {
        await ctx.loader.update(decision.id, {
          disabled: decision.disabled,
          config: Object.keys(decision.config).length ? decision.config : undefined,
        });
      } catch (err) {
        // Steady state, not boot: a module that refuses to recompose does not
        // bring the daemon down. At boot, an `apply` that throws still fails
        // the start — the activation audit says so.
        console.warn(`[kernel] ${decision.id} : recomposition impossible — ${(err as Error).message}`);
      }
    }

    const ids = changed.map((d) => d.id);
    console.log(`[kernel] modules recomposed live: ${changed.map((d) => `${d.id}=${d.disabled ? 'off' : 'on'}`).join(', ')}`);
    opts.onChange?.(ids);
    return ids;
  }

  const reconciler: BundledReconciler = {
    reconcile(): Promise<string[]> {
      // Serialized like `PluginLoader.update()`: the HTTP toggle and the file
      // watch fire on the same write, and two reconciliations in flight would
      // race on `current`.
      queue = queue.then(run, run);
      return queue;
    },

    watch(intervalMs = 1_000): () => void {
      if (watching || disposed) return () => reconciler.dispose();
      watching = true;
      // `watchFile` (polling) for the same reason as the plugin loader: an
      // editor that replaces the file destroys the inode an inotify watch
      // holds, and that watch never fires again.
      listener = () => {
        if (disposed) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          reconciler.reconcile().catch((err: Error) => console.warn('[kernel] recomposition:', err.message));
        }, 250);
        pending.unref();
      };
      const w = watchFile(CONFIG_FILE, { interval: intervalMs }, listener);
      w.unref();
      return () => reconciler.dispose();
    },

    dispose(): void {
      disposed = true;
      if (pending) clearTimeout(pending);
      pending = null;
      if (listener) unwatchFile(CONFIG_FILE, listener);
      listener = null;
      watching = false;
    },
  };
  return reconciler;
}

// The registry on the app lives apart (`bundled-reconciler.ts`) so the plugin switch can
// reach it without pulling the reconciler's kernel imports in; re-exported: no import moves.
export { attachBundledReconciler, reconcilerFromApp, type BundledReconciler } from './bundled-reconciler.js';
