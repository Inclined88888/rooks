/**
 * Module registry — decides WHO is loaded, before the Cordis loader
 * decides WHEN.
 *
 * Cordis only knows service dependencies (`inject`): it ignores
 * that a module needs Docker, a graphical session or a licence.
 * That is the role of this file — translating the module catalogue, the
 * configuration and the machine's capabilities into loader entries, each
 * marked `disabled` with a readable reason when it must not run.
 *
 * The principle that governs everything: configuration can only RESTRICT.
 * A `core` module cannot be disabled (without a database or settings, there is no
 * ROOKS), and a licence that does not cover a module wins over a `true`
 * written in `rooks.config.json`.
 */
import { fixedComposition, licenseCurrentlyValid } from '../license/capabilities.js';
import { licenseState } from '../license/runtime.js';
import type { LicenseState } from '../license/license.js';
import type { ModuleSetting, NovaConfig } from '../config/schema.js';
import { degradation } from './degradation.js';

export type ModuleTier = 'core' | 'std' | 'dev' | 'opt';

/** A row of the catalogue (§3.4 of the plan). The catalogue itself lives in `boot.ts`. */
export type ModuleDescriptor = {
  /** Key in `config.modules`, and stable identity of the entry for the loader. */
  id: string;
  /** Specifier passed to the loader (path relative to `dist/` or npm package). */
  name: string;
  tier: ModuleTier;
  /** Host capabilities without which the module cannot work. */
  requires?: string[];
  /**
   * Host capabilities whose absence degrades the module without switching it
   * off: capability → what is lost, shown as a warning in the gallery and in
   * `rooks doctor`. Moving a capability from here to `requires` switches the
   * module off instead (TODO #275, the Kanban and `git`).
   */
  recommends?: Record<string, string>;
  /** Expected Cordis services — documentary here, the module is the one declaring them. */
  inject?: string[];
  /** Sold module: only runs if the licence names it (§10.7). */
  licensed?: boolean;
  /** Browser module declared in the capabilities, without a fiber on the daemon side. */
  clientOnly?: boolean;
  /**
   * Other modules of the catalogue (by id) without which this one cannot
   * run. It is NOT `inject`: `inject` names Cordis services, and
   * Cordis merely waits — the fiber stays PENDING silently, and
   * `auditActivation` then makes the daemon exit with code 2. A module switched off
   * on purpose must switch off those that depend on it, not make the
   * boot fail.
   */
  dependsOn?: string[];
  /**
   * Shipped switched off: it runs only once `modules[id]` asks for it
   * (`true`, or `{ enabled: true }`). `auto` and an absent key leave it off.
   * For a feature that opens a door the user must choose to open (the
   * Machines fleet, TODO #329), not for one that merely costs resources.
   */
  offByDefault?: boolean;
};

/**
 * What a bundled module declares about itself. `boot.ts` derives from it a
 * `ModuleDescriptor` (adding the loading specifier); the module
 * does not have to know its own path on disk.
 */
export type ModuleManifest = {
  /** Key in `config.modules`. */
  name: string;
  tier: ModuleTier;
  /** Required host capabilities (see `doctor.diagnose()`). */
  requires?: string[];
  /** Required Cordis services — taken as is into the plugin's `inject`. */
  inject?: string[];
  /**
   * Sold module (§10.7): the licence must name it for it to run. Absent
   * or `false` = free module, a restrictive licence does not touch it.
   */
  licensed?: boolean;
};

export type EntryDecision = {
  id: string;
  name: string;
  tier: ModuleTier;
  disabled: boolean;
  /** Why the module does not run. `null` when it runs. */
  reason: string | null;
  /** Missing capabilities, even when the module is forced on. */
  missing: string[];
  /** What a running module loses to a missing `recommends` capability; `null` otherwise. */
  warning?: string | null;
  /** Module options, extracted from `config.modules[id]` if it is an object. */
  config: Record<string, unknown>;
  clientOnly?: boolean;
};

/** Entry as the Cordis loader expects it. */
export type LoaderEntry = {
  id: string;
  name: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
};

function settingOf(v: ModuleSetting | undefined): { wanted: boolean | 'auto'; config: Record<string, unknown> } {
  if (v === undefined) return { wanted: 'auto', config: {} };
  if (typeof v === 'boolean' || v === 'auto') return { wanted: v, config: {} };
  const { enabled, ...rest } = v as Record<string, unknown>;
  const wanted = enabled === undefined ? 'auto' : (enabled as boolean | 'auto');
  return { wanted, config: rest };
}

/**
 * Translates the catalogue into decisions. `capabilities` comes from the host
 * diagnosis (`doctor.diagnose()` today, `host.capabilities()` in Phase 2);
 * `licensed`, when provided, is the licence's allowlist.
 */
export function planEntries(
  catalog: readonly ModuleDescriptor[],
  opts: { config: NovaConfig; capabilities: readonly string[]; licensed?: readonly string[]; license?: LicenseState },
): EntryDecision[] {
  const state = opts.license ?? licenseState();
  const fixed = fixedComposition(state);
  const caps = new Set(opts.capabilities);
  const licensed = opts.licensed ? new Set(opts.licensed) : null;

  const decisions = catalog.map((m) => {
    const { wanted, config } = settingOf(opts.config.modules[m.id]);
    const missing = (m.requires ?? []).filter((c) => !caps.has(c));
    const decide = (): string | null => {
      // The core is not negotiable: disabling it would not produce a
      // lighter installation, but a dead one.
      if (m.tier === 'core') return null;
      if (fixed) {
        // Host availability may make a bundled integration unavailable; user
        // configuration never changes which product modules the offer contains.
        // Recovery and account data stay accessible; the update offer is the
        // only way out of an ended beta build, so it keeps running too.
        if (['@rooks/users', '@rooks/ui-layout', '@rooks/ui-theme', '@rooks/web-app', '@rooks/updates'].includes(m.id)) return null;
        if (!licenseCurrentlyValid(state) || state.modules === '*' || !state.modules.includes(m.id)) return 'not included in this licence';
        return missing.length ? `host capability unavailable: ${missing.join(', ')}` : null;
      }
      // The licence ONLY governs the sold modules. A free module stays
      // active under a restrictive licence: without that, a Lite licence
      // would switch off everything it does not name, and "no licence" (§10.7)
      // would make the product unusable instead of merely restricted.
      if (m.licensed && licensed && !licensed.has(m.id)) return 'not included in this licence';
      if (wanted === false) return 'disabled in rooks.config.json';
      if (wanted === true) return null; // forced: missing capabilities are reported, not blocking
      if (m.offByDefault) return 'off by default';
      if (missing.length) return `host capability unavailable: ${missing.join(', ')}`;
      return null;
    };
    const reason = decide();
    const warning = reason === null ? degradation(m, caps) : null;
    return { id: m.id, name: m.name, tier: m.tier, disabled: reason !== null, reason, missing, config, ...(warning ? { warning } : {}), ...(m.clientOnly ? { clientOnly: true } : {}) };
  });

  return cascadeDependencies(catalog, decisions);
}

/**
 * Expands `license.modules` into the concrete ids `planEntries` expects. The
 * ONLY place that unfolds `'*'` — boot and the hot reconciler both call this
 * instead of each doing their own expansion, which is exactly the drift the
 * boot comment warns against (two ways to unfold `'*'` would eventually
 * disagree).
 */
export function licensedModulesOf(catalog: readonly ModuleDescriptor[], modules: readonly string[] | '*'): string[] {
  return modules === '*' ? catalog.filter((entry) => entry.licensed).map((entry) => entry.id) : [...modules];
}

/**
 * Propagates the switch-off along `dependsOn`, up to the fixed point (a chain
 * A → B → C switches off entirely, whatever the catalogue order).
 *
 * A `core` module is never switched off by cascade: it is not allowed to
 * be, and a missing dependency towards it would signal a wrong catalogue,
 * not a configuration.
 */
function cascadeDependencies(
  catalog: readonly ModuleDescriptor[],
  decisions: EntryDecision[],
): EntryDecision[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const deps = new Map(catalog.map((m) => [m.id, m.dependsOn ?? []]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decisions) {
      if (d.disabled || d.tier === 'core') continue;
      const off = (deps.get(d.id) ?? []).find((id) => byId.get(id)?.disabled ?? false);
      if (off === undefined) continue;
      d.disabled = true;
      d.reason = `depends on ${off}, which is disabled`;
      changed = true;
    }
  }
  return decisions;
}

/** Decisions → loader entries. Disabled entries are kept:
 *  re-enabling a module must be a hot toggle, not a restart. */
export function toLoaderEntries(decisions: readonly EntryDecision[]): LoaderEntry[] {
  return decisions.filter((d) => !d.clientOnly).map((d) => ({
    id: d.id,
    name: d.name,
    ...(d.disabled ? { disabled: true } : {}),
    ...(Object.keys(d.config).length ? { config: d.config } : {}),
  }));
}

export type CapabilitiesReport = {
  edition: string;
  profile: string;
  capabilities: string[];
  modules: {
    id: string;
    tier: ModuleTier;
    active: boolean;
    reason: string | null;
    missing: string[];
    /** Degraded but running (`ModuleDescriptor.recommends`); `null` otherwise. */
    warning: string | null;
    /**
     * Module options as `config.modules[id]` sets them, `enabled`
     * removed. The front needs them: an option that decides a SURFACE can be
     * read neither in the tier nor in `ui.hidden`, and the only alternative would be
     * a second route per module.
     *
     * Deliberate pass-through: the kernel knows none of these keys, it is the
     * module (or its client half) that validates them and sets their default.
     */
    options: Record<string, unknown>;
  }[];
};

/** What `GET /api/capabilities` serves (step 1.8): enough for the front
 *  to hide what does not exist, rather than show dead buttons. */
export function capabilitiesReport(
  decisions: readonly EntryDecision[],
  opts: { config: NovaConfig; capabilities: readonly string[] },
): CapabilitiesReport {
  return {
    edition: opts.config.edition,
    profile: opts.config.profile,
    capabilities: [...opts.capabilities],
    modules: decisions.map((d) => ({
      id: d.id,
      tier: d.tier,
      active: !d.disabled,
      reason: d.reason,
      missing: d.missing,
      warning: d.warning ?? null,
      options: d.config,
    })),
  };
}
