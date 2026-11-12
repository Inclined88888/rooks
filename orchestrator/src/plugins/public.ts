/**
 * Public shape of a plugin — what `GET /api/plugins` and the SSE event
 * `plugins_changed` return. A single writer, two readers: the front must
 * not learn a field on one side and lose it on the other.
 *
 * This is not a security filter. It is a DTO: the real state of the loader,
 * plus the URL of the browser half when it is actually served.
 */
import type { BundledModuleRow } from '../kernel/capabilities.js';
import type { ModuleTier } from '../kernel/registry.js';
import type { Bundle } from './bundles.js';
import type { Cover } from './covers.js';
import { bundledIconUrl } from './bundled-icons.js';
import { BUNDLED_AUTHOR, bundledIdentity } from './bundled-identity.js';
import type { PluginState, PluginStatus } from './loader.js';
import type { PluginDictationEngineDecl, PluginKind, PluginMascotDecl, PluginSetting } from './manifest.js';

export type PluginClientInfo = {
  url: string;
  rev: string;
  /** Line-ending-blind digest of the browser half (`Bundle.digest`). */
  digest: string;
  slots: string[];
  /** Manifest permissions: the browser half gates the kinds that need one (`missions:transcript`). */
  permissions?: string[];
};

export type PluginPublic = {
  id: string;
  pkg: string;
  /** Empty for a bundled module: it ships with the product, it has no version of its own. */
  version: string;
  /**
   * Where the plugin comes from. A bundled module is a module of the product
   * (`CATALOG`), a third-party one a package installed under `~/.rooks/plugins/`.
   * The gallery lists BOTH — an install that shows nothing would be a lie.
   */
  source: 'bundled' | 'third-party';
  /** Catalogue tier of a bundled module, `null` for a third-party package. A
   *  `core` tier is what forbids the toggle: turning the kernel off bricks the
   *  daemon. */
  tier: ModuleTier | null;
  /**
   * Bundled only (`null` otherwise): what `config.modules[id]` asks for. Kept
   * apart from `state`, which is what the daemon runs — a licence or a missing
   * host capability can refuse a module the switch still shows as wanted.
   */
  wanted: boolean | 'auto' | null;
  /**
   * What the plugin IS. Always a list: `readManifest` infers it from the
   * slots when the manifest does not carry it. Empty only for a refused
   * package, whose manifest could not be read.
   */
  kind: PluginKind[];
  /** Gallery title. `null` → the card shows the `id`. */
  label: string | null;
  description: string | null;
  /**
   * Third-party Ed25519 admission. `null` for a bundled module (trust is the
   * catalogue, not a signature). `false` when unsigned, even if developer
   * mode still loaded it.
   */
  signed: boolean | null;
  /**
   * The admitted Ed25519 signature: digest of the package's files and signing
   * key. `null` for a bundled module and for an unsigned package. With
   * `version`, it is what another machine's interface compares before
   * mounting this plugin's browser half from its own copy (multi-machine P4c).
   */
  signature: { hash: string; keyId: string } | null;
  /**
   * A third-party package shipped with the product (`builtin.ts`): it can be
   * disabled, never uninstalled. Always `false` for a bundled module.
   */
  builtin: boolean;
  /** Publisher. Bundled modules are `Rooks`; third-party ones declare it or stay `null`. */
  author: string | null;
  /**
   * Extra stills for the detail sheet, in gallery order. Empty until a
   * package ships them — the sheet keeps the slot so a carousel can land
   * without another DTO change.
   */
  screenshots: string[];
  /** URL of the served cover, `null` if the package does not ship one. */
  cover: string | null;
  /**
   * Gallery picto: the served `rooks.icon` of a package, a `data:` URL for a
   * bundled module (`bundled-icons.ts`), `null` when there is none.
   */
  icon: string | null;
  /**
   * Where it plugs in. Read from the MANIFEST, not from the bundle: `client` is
   * `null` as soon as the plugin is not active, yet the gallery must show where
   * a plugin that was just unplugged would plug in.
   */
  slots: string[];
  /** Route mounted by a `kind: page`. */
  route: string | null;
  /** Sockets it opens to the others. */
  declares: Record<string, 'single' | 'list' | 'keyed'>;
  /** What it changes without occupying it (a theme…). */
  modifies: string[];
  /** Ids a `kind: bundle` installs along with it. */
  contains: string[];
  state: PluginState;
  /** `skipped:<code>` / reason for disabling / `failed`. `null` if it runs. */
  reason: string | null;
  /**
   * Bundled only: the module runs, but a missing host capability takes part
   * of it away (`ModuleDescriptor.recommends`). Absent otherwise.
   */
  warning?: string;
  error: string | null;
  /** Browser half served right now — `null` if missing, refused or inactive. */
  client: PluginClientInfo | null;
  settings: PluginSetting[];
  /** Names of the incoming webhooks it declares (`rooks.webhooks`). */
  webhooks: string[];
  backends?: PluginStatus['backends'];
  /**
   * `kind: dictation` only (API 14): where each engine sends the voice, as the
   * manifest declares it. The browser half reads it to name the destination
   * in the gallery and the Voice pane, and to ask its consent again when an
   * engine's `egress` changes — an engine never says it of itself. `null`
   * for any other plugin and for a bundled module.
   */
  dictation: { engines: PluginDictationEngineDecl[]; models: string | null } | null;
  /**
   * The parts of a mascot pack (API 15), as its manifest declares them. The
   * browser half's drawings are admitted against it: a part the daemon would
   * refuse at save is never offered. `null` for any other plugin.
   */
  mascot: PluginMascotDecl | null;
};

export function toPublicPlugin(
  status: PluginStatus,
  bundles: { get(id: string): Bundle | null },
  covers?: { get(id: string): Cover | null; listStills?(id: string): Cover[]; getIcon?(id: string): Cover | null },
): PluginPublic {
  const bundle = status.state === 'active' ? bundles.get(status.id) : null;
  const manifest = status.manifest;
  return {
    id: status.id,
    pkg: status.pkg,
    version: status.version,
    source: 'third-party',
    tier: null,
    wanted: null,
    kind: [...(manifest?.kind ?? [])],
    label: manifest?.label ?? null,
    description: manifest?.description ?? null,
    author: manifest?.author ?? null,
    signed: status.signed,
    signature: status.signature ? { ...status.signature } : null,
    builtin: status.builtin === true,
    screenshots: (covers?.listStills?.(status.id) ?? []).map((c) => c.url),
    cover: covers?.get(status.id)?.url ?? null,
    icon: covers?.getIcon?.(status.id)?.url ?? null,
    slots: [...(manifest?.client?.slots ?? [])],
    route: manifest?.route ?? null,
    declares: { ...(manifest?.declares ?? {}) },
    modifies: [...(manifest?.modifies ?? [])],
    contains: [...(manifest?.contains ?? [])],
    state: status.state,
    reason: status.reason,
    error: status.error,
    settings: [...(status.manifest?.settings ?? [])],
    webhooks: (status.manifest?.webhooks ?? []).map((w) => w.name),
    ...(status.backends ? { backends: status.backends.map((p) => ({ ...p })) } : {}),
    dictation: manifest?.kind.includes('dictation') && manifest.dictation
      ? {
        engines: manifest.dictation.engines.map((e) => ({ ...e, egress: Array.isArray(e.egress) ? [...e.egress] : e.egress })),
        models: manifest.dictation.models ?? null,
      }
      : null,
    mascot: manifest?.mascot ? copyMascot(manifest.mascot) : null,
    client: bundle
      ? { url: bundle.url, rev: bundle.rev, digest: bundle.digest, slots: [...(status.manifest?.client?.slots ?? [])], permissions: [...(status.manifest?.permissions ?? [])] }
      : null,
  };
}

/**
 * A bundled module in the same shape as a third-party plugin, so the gallery
 * has one list and one card (plan §10.12).
 *
 * The catalog has no `rooks` manifest — `bundled-identity.ts` is that half
 * of the contract (kind, slots, route, declares). Label and long copy live
 * in the front's locale files: the daemon would otherwise freeze them in
 * English. `author` is the brand; there is no third-party publisher here.
 *
 * `state` splits the two refusals the user must tell apart: `disabled` is the
 * one they caused (`modules[id] = false`), `skipped` the one the daemon
 * imposes (licence, missing host capability).
 */
export function toPublicBundled(row: BundledModuleRow): PluginPublic {
  const state: PluginState = row.active ? 'active' : row.wanted === false ? 'disabled' : 'skipped';
  const identity = bundledIdentity(row.id);
  return {
    id: row.id,
    pkg: row.id,
    version: '',
    source: 'bundled',
    tier: row.tier,
    wanted: row.wanted,
    kind: [...identity.kind],
    label: null,
    description: null,
    author: BUNDLED_AUTHOR,
    signed: null,
    signature: null,
    builtin: false,
    screenshots: [],
    cover: null,
    icon: bundledIconUrl(row.id),
    slots: [...identity.slots],
    route: identity.route,
    declares: { ...identity.declares },
    modifies: [],
    contains: [],
    state,
    reason: row.reason,
    ...(row.warning ? { warning: row.warning } : {}),
    error: null,
    client: null,
    settings: [],
    webhooks: [],
    dictation: null,
    mascot: null,
  };
}

function copyMascot(block: PluginMascotDecl): PluginMascotDecl {
  const out: PluginMascotDecl = {};
  for (const type of ['shape', 'color', 'eyes', 'acc'] as const) {
    if (block[type]) out[type] = [...block[type]];
  }
  return out;
}
