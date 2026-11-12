/**
 * What `rooks module list|enable|disable` writes and reads (step 3.7).
 *
 * Like `rooks plugin`, these commands are LOCAL: they only set a wanted
 * state in `~/.rooks/rooks.config.json` and need neither to reach the
 * daemon, nor for it to run. And as for third-party plugins, a running daemon
 * applies the toggle HOT: it watches this file and recomposes
 * the tree (`kernel/bundled-reload.ts`). No restart is asked for — it
 * would kill every living mission.
 *
 * This file decides nothing: `planEntries` stays the sole judge of what runs
 * (licence, host capabilities, `core` tier). We only give it to read what
 * the config says, and write into it.
 */
import { assertCompositionMutable } from '../license/capabilities.js';
import { mutationLicenseState } from '../license/runtime.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_FILE, loadConfig } from '../config/load.js';
import type { ModuleSetting } from '../config/schema.js';
import { getHost } from '../host/index.js';
import { CATALOG } from './catalog.js';
import { canonicalModuleId } from './legacy-ids.js';
import { planEntries, type ModuleDescriptor, type ModuleTier } from './registry.js';

type Json = Record<string, unknown>;

// The same four lines as in `plugins/install.ts`, duplicated on purpose:
// importing them would make the kernel depend on the third-party plugin installer,
// for a JSON read.
function readJson(file: string): Json {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: the root must be a JSON object`);
  }
  return parsed as Json;
}

function writeJson(file: string, data: Json): void {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export type ModuleRow = {
  id: string;
  tier: ModuleTier;
  /** What the config asks for: `true`, `false` or `'auto'` (the default). */
  wanted: boolean | 'auto';
  /** What the kernel would do with it AT THE NEXT BOOT, capabilities and licence included. */
  active: boolean;
  /** Why it would not run. `null` when it runs. */
  reason: string | null;
  missing: string[];
};

export function wantedOf(v: ModuleSetting | undefined): boolean | 'auto' {
  if (v === undefined) return 'auto';
  if (typeof v === 'boolean' || v === 'auto') return v;
  const enabled = (v as { enabled?: boolean | 'auto' }).enabled;
  return enabled === undefined ? 'auto' : enabled;
}

/**
 * `rooks module list`. The capabilities are injectable for the tests: reading them
 * from the real host would make the result depend on the machine running the suite.
 */
export function listModules(opts: {
  file?: string;
  catalog?: readonly ModuleDescriptor[];
  capabilities?: readonly string[];
  licensed?: readonly string[];
} = {}): ModuleRow[] {
  const catalog = opts.catalog ?? CATALOG;
  const cfg = loadConfig(opts.file ?? CONFIG_FILE);
  const capabilities = opts.capabilities ?? getHost().capabilities();
  const decisions = planEntries(catalog, { config: cfg, capabilities, licensed: opts.licensed, license: mutationLicenseState() });
  return decisions.map((d) => ({
    id: d.id,
    tier: d.tier,
    wanted: wantedOf(cfg.modules[d.id]),
    active: !d.disabled,
    reason: d.reason,
    missing: d.missing,
  }));
}

export class UnknownModuleError extends Error {}
export class CoreModuleError extends Error {}

/**
 * The bundled half that occupies the `theme` slot as its default occupant.
 *
 * Not `core` — it is browser code, the daemon does not need it — but not
 * switchable off either: the client mounts bundled halves only for modules
 * that are on (`plugins-client/mount.ts`), so turning this one off leaves the
 * `single` slot with NO occupant at all. Every palette token lives in it since
 * T.3, so the answer is not "the product palette comes back", it is 125
 * undefined custom properties — including in the gallery you would have to
 * come back to in order to undo it.
 *
 * The id is repeated here rather than imported: the daemon and the front are
 * two packages that do not import each other (same rule as
 * `PRODUCT_THEME_PLUGIN` in `app/src/lib/plugin-host/loader.ts`).
 */
export const PRODUCT_THEME_MODULE = '@rooks/ui-theme';

/**
 * `rooks module enable|disable <id>` — writes `modules[<id>]` into
 * `rooks.config.json`.
 *
 * Two explicit refusals rather than two silent no-ops:
 *  - an id missing from the catalogue (a typo would set a dead key that
 *    nobody would ever read again, while suggesting the module is set);
 *  - disabling a `core` module, which `planEntries` ignores
 *    anyway — without a database or settings there is no ROOKS. Writing `false` to no
 *    effect would be worse than refusing.
 *
 * An object value is KEPT: its other keys are the options passed to
 * `apply`, and losing them by disabling for five seconds would reset the
 * module's configuration.
 */
export function setModuleEnabled(
  id: string,
  enabled: boolean,
  file: string = CONFIG_FILE,
  catalog: readonly ModuleDescriptor[] = CATALOG,
): void {
  assertCompositionMutable(mutationLicenseState());
  // A legacy id (`grepai`) is still accepted as input, but it is the current id
  // that gets written: the user's config converges to the new schema
  // at the first gesture, without us having to rewrite their file behind their back.
  // The id as is is tried FIRST — the alias must not divert a
  // catalogue that would still carry the old name.
  const descriptor = catalog.find((m) => m.id === id) ?? catalog.find((m) => m.id === canonicalModuleId(id));
  const canonical = descriptor?.id ?? id;
  if (!descriptor) {
    throw new UnknownModuleError(`unknown module: ${id} (rooks module list)`);
  }
  if (descriptor.tier === 'core' && !enabled) {
    throw new CoreModuleError(`${canonical} is a core module: it cannot be disabled`);
  }
  if (canonical === PRODUCT_THEME_MODULE && !enabled) {
    // Same error class as `core`: the route answers 403 either way, and the
    // two refusals mean the same thing to whoever reads them — this switch
    // does not exist. Changing the palette is a preference (Appearance), not
    // an on/off on the module that carries every token.
    throw new CoreModuleError(
      `${canonical} carries every colour token: turning it off leaves the \`theme\` slot empty.`
      + ' Change the theme in Appearance, or install a theme that claims the slot.',
    );
  }

  const cfg = readJson(file);
  const modules = (typeof cfg.modules === 'object' && cfg.modules !== null && !Array.isArray(cfg.modules))
    ? (cfg.modules as Json)
    : {};
  const current = modules[canonical] ?? modules[id];
  if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
    (current as Json).enabled = enabled;
    if (canonical !== id && modules[canonical] === undefined) {
      modules[canonical] = current;
      delete modules[id];
    }
  } else {
    modules[canonical] = enabled;
    if (canonical !== id) delete modules[id];
  }
  cfg.modules = modules;
  writeJson(file, cfg);
}
