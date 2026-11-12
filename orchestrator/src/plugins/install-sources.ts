/**
 * Installing a third-party plugin from the gallery (TODO #332): a folder, a
 * `.tgz` or a `.zip` (TODO #345) picked on the PC, an archive uploaded by a
 * browser, or a package dropped in `~/.rooks/plugins/` and not installed yet.
 *
 * Two steps, and nothing of the package runs in between:
 *
 *  1. `stage*` copies the source into a staging folder the daemon owns, reads
 *     its manifest and checks its Ed25519 signature — no import, no npm. The
 *     caller gets back a PREVIEW and an opaque token.
 *  2. `installStaged(token)` hands the staged package to `addPlugin`, the very
 *     path of `rooks plugin add` (`npm install --ignore-scripts`, signature
 *     re-checked on the installed files). There is no second way in.
 *
 * Copying at step 1 is what makes step 2 install what was previewed: a folder
 * edited after the preview, or a path swapped for another, is not re-read.
 * Except for a package already in the drop folder: it is previewed and then
 * installed IN PLACE, so between the two steps the only guard is the
 * signature `addPlugin` checks again on the installed files — an unsigned
 * one (when unsigned plugins are allowed) installs as it is at confirmation.
 * And npm LINKS a local folder rather than copying it, so a folder installed
 * from the user's Downloads would break the day they tidy it up: a picked
 * folder therefore lands in `~/.rooks/plugins/<name>/` before npm sees it, an
 * archive in `~/.rooks/plugins/<name>-<version>.tgz`. Both then show up as
 * "available" again if the plugin is removed — the drop folder is the list.
 *
 * npm cannot install a `.zip`: one is extracted (`zip-reader.ts`) and then
 * handled exactly as a picked folder — copied into `~/.rooks/plugins/<name>/`
 * and handed to the same `addPlugin`, signature checked on the same files.
 * Which reader runs is decided by the archive's first bytes, never by the
 * name or the MIME type a browser sent. A `.zip` left in the drop folder is
 * not listed: npm could not install it in place.
 *
 * What never leaves this module: an absolute path, or the bytes of a file the
 * manifest did not name. The preview carries parsed manifest fields, the
 * signature verdict, and the icon/cover the manifest declares, inlined as
 * `data:` URLs once confined to the package (`realpath` included — a symlink
 * in a dropped folder must not turn the preview into a file reader).
 */
import { randomBytes } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILE, config } from '../config/load.js';
import { PLUGINS_DIR, ROOKS_HOME } from '../paths.js';
import { resolveBuiltins } from './builtin.js';
import { resolveCoverFile } from './covers.js';
import { checkProviderBinaries, ExecGrantError, grantProviderBinaries, providerBinaryRequests, removeAllowEntries, type ProviderBinaryRequest } from './exec-grants.js';
import { addPlugin, PluginEngineError, type AddResult, type InstallOptions } from './install.js';
import { dictationModelsProblem, discoverPlugins, hasHostHalf, installedPackages } from './loader.js';
import { currentNodeRuntime, nodeEngineProblem } from './node-engine.js';
import { dictationEgressLines, readManifest, type PluginDictationEngineDecl, type PluginManifest } from './manifest.js';
import { PLUGIN_PUBLIC_KEYS, unsignedPluginsAllowed, type PluginPublicKey } from './pubkey.js';
import { verifyPluginDirectory } from './signature.js';
import {
  applyVaultGrants, planChildVaultGrants, planVaultGrants, pluginVaultRequests, rollbackVaultGrants, vaultRequestsKey, VaultGrantError,
  type ChildVaultConsent, type PluginVaultRequests, type VaultConsent, type VaultGranted, type VaultGrantPlan, type VaultGrantUndo,
} from './vault-grants.js';
import { boundPluginPackage, pluginPackageChanged, settlePluginPackage, signsUnsignedCopy, type PluginPackage } from './package-binding.js';
import { DEFAULT_TAR_LIMITS, extractTarGz, readTarGz, TarError, type TarLimits } from './tar-reader.js';
import { extractZip, isZip, ZipError } from './zip-reader.js';

/** Why a source cannot be staged. `status` is the HTTP answer. */
export class PluginSourceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginSourceError';
  }
}

export type SignatureVerdict =
  | { state: 'signed'; keyId: string }
  /** `loads`: whether the daemon would mount it today (developer mode, licence). */
  | { state: 'unsigned'; loads: boolean }
  | { state: 'tampered' };

export type PluginOrigin = 'upload' | 'path' | 'detected';

/**
 * One `contains` entry of a bundle, before anything is installed (TODO #660):
 *  - `install`: a package of the bundle declares this id and it is not installed
 *    yet. `vault` lists what it names, consented per child (`vaultChildren`);
 *    `provider` the programs it launches, accepted per child
 *    (`authorizeExecChildren`, TODO #673); `dictation` where it sends the voice;
 *  - `kept`: already installed: the bundle does not touch it, nothing to consent;
 *  - `unreadable`: a dependency may bring it, but its manifest cannot be read
 *    without npm (a registry range, a path out of the plugins folder): nothing
 *    can be shown, so nothing can be granted to it from this sheet;
 *  - `unresolved`: every dependency was read and none declares this id.
 */
export type BundleChildPreview = {
  id: string;
  pkg: string | null;
  version: string | null;
  label: string | null;
  state: 'install' | 'kept' | 'unreadable' | 'unresolved';
  permissions: string[];
  /** `null` unless `install`. */
  signature: SignatureVerdict | null;
  /** `null` when it names nothing, or for a child whose signature is broken: it will not load. */
  vault: PluginVaultRequests | null;
  /** Same as `PluginPreview.provider`; `null` when it is not a provider, or will not load. */
  provider: PluginPreview['provider'];
  /** Same as `PluginPreview.dictation`; `null` when it takes no voice, or will not load. */
  dictation: PluginPreview['dictation'];
  /** Same as `PluginPreview.replaces`, for this child (TODO #684). */
  replaces: string | null;
  /**
   * Same as `PluginPreview.engineError`, for this child (TODO #794): it lands
   * with the bundle but the daemon will not load it, so nothing is asked for it.
   */
  engineError: string | null;
};

/** What became of a child's consent. `refused`: nothing was granted to it. */
export type ChildVaultOutcome = { id: string } & (
  | { granted: VaultGranted; refused: null }
  /** `not-installed`: it did not land; `changed`: what landed is not what was shown; `grant-failed`: the vault refused. */
  | { granted: null; refused: 'not-installed' | 'changed' | 'grant-failed' }
);

/** The programs of a child, as the sheet showed them and the person accepted them (TODO #673). */
export type ChildExecConsent = { id: string; pkg: string; version: string; paths: readonly string[] };

/** What became of an accepted child's programs. `refused`: nothing was allowlisted for it. */
export type ChildExecOutcome = { id: string } & (
  | { granted: string[]; refused: null }
  /** `not-installed`: it did not land; `changed`: what landed is not what was shown; `grant-failed`: the file could not be written. */
  | { granted: null; refused: 'not-installed' | 'changed' | 'grant-failed' }
);

export type PluginPreview = {
  token: string;
  origin: PluginOrigin;
  format: 'archive' | 'folder';
  pkg: string;
  version: string;
  /** `null` when the manifest is refused: `manifestError` says why. */
  id: string | null;
  label: string | null;
  description: string | null;
  author: string | null;
  kind: string[];
  permissions: string[];
  slots: string[];
  route: string | null;
  declares: Record<string, string>;
  modifies: string[];
  contains: string[];
  settings: string[];
  webhooks: string[];
  /**
   * `kind: provider` only: the binaries it launches, as THIS host resolves them.
   * The superadmin accepts the resolved paths with the install (`authorizeExec`).
   * `credentialDirs`: the home folders its CLI keeps the sign-in in (listed on the same screen).
   * `osCredentials`: the OS credential-store entries it reads (macOS keychain), declared so the
   * consent sheet can say it; nothing else is readable.
   */
  provider: { binaries: ProviderBinaryRequest[]; osCredentials: Array<{ service: string; account?: string }>; credentialDirs: string[] } | null;
  /**
   * `kind: dictation` only: where each engine sends the voice (`egress`), and
   * `lines`, the same said in one English sentence per engine, for a sheet that
   * has no translation of its own (`dictationEgressLines`).
   */
  dictation: { engines: PluginDictationEngineDecl[]; models: string | null; lines: string[] } | null;
  /**
   * The secrets and hosts the manifest names (`secrets`, `http.hosts`, TODO #599),
   * each with where it stands on this daemon. `null` when it names neither.
   * The superadmin ticks what to grant and sends every line back with the
   * install (`vault`, `vault-grants.ts`).
   */
  vault: PluginVaultRequests | null;
  /** `kind: bundle` only: its `contains`, each with what it names. Empty otherwise. */
  children: BundleChildPreview[];
  licenseRequired: boolean;
  /** `data:` URLs, never a path. */
  icon: string | null;
  cover: string | null;
  signature: SignatureVerdict;
  manifestError: string | null;
  /**
   * The package's `engines.node` excludes the Node the daemon runs plugins on
   * (TODO #763): the refusal, naming both versions. `null` otherwise.
   */
  engineError: string | null;
  /** Version already installed under the same id or npm name. */
  installed: { version: string } | null;
  /** npm name of the package gone from this id: what it was granted goes when this one lands (`package-binding.ts`). */
  replaces: string | null;
  /**
   * This signed package is the release of the unsigned copy of its own name on
   * record: an update, its data, settings and grants kept (`keepsPluginData`).
   */
  updatesUnsigned: boolean;
  /** `false` with `blocked` set when the Install button must stay off. */
  installable: boolean;
  blocked: 'manifest' | 'tampered' | 'node-engine' | null;
};

export type PluginCandidate = {
  /** Entry name in the plugins folder — what `stageDetected` takes back. */
  name: string;
  format: 'archive' | 'folder';
  pkg: string;
  version: string;
  id: string | null;
  label: string | null;
  description: string | null;
  kind: string[];
};

type Staged = {
  token: string;
  createdAt: number;
  origin: PluginOrigin;
  format: 'archive' | 'folder';
  /** Staging folder to delete afterwards; `null` for a dropped folder read in place. */
  root: string | null;
  /** Package files: extracted archive, copied folder, or the dropped folder. */
  dir: string;
  /** What `addPlugin` receives once confirmed. */
  install: { kind: 'in-place'; path: string } | { kind: 'archive'; file: string } | { kind: 'folder' };
  pkg: string;
  version: string;
  blocked: PluginPreview['blocked'];
  /** The `engines.node` refusal of the preview, said again if the install is tried anyway. */
  engineError: string | null;
  /**
   * Local dependencies of a picked folder (`file:../sibling`), staged next to
   * it: laid in the plugins folder where that relative path points once the
   * package itself lands there. Empty for every other source.
   */
  siblings?: StagedSibling[];
};

type StagedSibling = { dir: string; pkg: string; rel: string };

/** Where a package's files are, to read its bundle's children from. */
type ChildSource = Pick<Staged, 'dir' | 'format' | 'install' | 'siblings'>;

/** A child as read, with the manifest the preview does not hand out. */
type ChildRead = { preview: BundleChildPreview; manifest: PluginManifest | null; takenOver: boolean };

/** A child's consent, ready to apply once it has landed as it was shown. */
type ChildGrant = { id: string; pkg: string; version: string; signature: string; requests: string; takenOver: boolean; plan: VaultGrantPlan };

/** A child's accepted programs, ready to allowlist once it has landed as it was shown. */
type ChildExecGrant = { id: string; pkg: string; version: string; signature: string; provider: string; paths: readonly string[] };

export type InstallSourceOptions = {
  /** `~/.rooks/plugins`. */
  pluginsRoot?: string;
  /** Where staged copies live (`~/.rooks/tmp/plugin-install`). */
  stagingRoot?: string;
  /** Paths a picked source may NOT come from (the Rooks home). */
  forbiddenRoots?: readonly string[];
  limits?: TarLimits;
  publicKeys?: readonly PluginPublicKey[];
  unsignedLoads?: () => boolean;
  /** Forwarded to `addPlugin` (tests inject npm). */
  install?: InstallOptions;
  /** The operator's `rooks.config.json`, where an accepted binary is allowlisted. */
  configFile?: string;
  now?: () => number;
};

const TTL_MS = 15 * 60_000;
const MAX_STAGED = 10;
const MAX_SCANNED = 200;
const ICON_MAX_BYTES = 64 * 1024;
const COVER_MAX_BYTES = 2 * 1024 * 1024;
const ARCHIVE_RE = /\.(tgz|tar\.gz)$/i;
/** Accepted from a picked path, never listed from the drop folder (see the header). */
const ZIP_RE = /\.zip$/i;
const GZIP_MAGIC = [0x1f, 0x8b] as const;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const SKIPPED_NAMES = new Set(['node_modules', 'package.json', 'package-lock.json']);
/** A relative local spec, the only kind a sibling can be laid back for. */
const RELATIVE_LOCAL_SPEC = /^(file:)?\.{1,2}[\\/]/;
const MAX_SIBLINGS = 20;
/** Manifests read for one bundle; a dependency past it is `unreadable`. Also the bound of `vaultChildren`. */
export const MAX_BUNDLE_CHILDREN = 64;

/**
 * One instance per daemon. The staged packages live in memory and on disk for
 * `TTL_MS`: a preview nobody confirms is swept, a token never outlives it.
 */
export class PluginInstallSources {
  private readonly staged = new Map<string, Staged>();
  /** Archive listing is a gunzip per file: re-read only what changed on disk. */
  private readonly candidateCache = new Map<string, { stamp: string; read: PluginCandidate | null }>();
  private readonly pluginsRoot: string;
  private readonly stagingRoot: string;
  private readonly forbiddenRoots: readonly string[];
  private readonly limits: TarLimits;
  private readonly keys: readonly PluginPublicKey[];
  private readonly unsignedLoads: () => boolean;
  private readonly now: () => number;

  constructor(private readonly opts: InstallSourceOptions = {}) {
    this.pluginsRoot = resolve(opts.pluginsRoot ?? PLUGINS_DIR);
    this.stagingRoot = resolve(opts.stagingRoot ?? join(ROOKS_HOME, 'tmp', 'plugin-install'));
    this.forbiddenRoots = (opts.forbiddenRoots ?? [ROOKS_HOME]).map((p) => resolve(p));
    this.limits = opts.limits ?? DEFAULT_TAR_LIMITS;
    this.keys = opts.publicKeys ?? PLUGIN_PUBLIC_KEYS;
    this.unsignedLoads = opts.unsignedLoads ?? (() => unsignedPluginsAllowed(config().developer.unsignedPlugins));
    this.now = opts.now ?? Date.now;
  }

  /** Packages dropped in the plugins folder and not installed. */
  candidates(): PluginCandidate[] {
    const installed = this.installedIndex();
    const out: PluginCandidate[] = [];
    for (const entry of this.dropEntries()) {
      const read = this.readCandidate(entry.name, entry.format);
      if (!read) continue;
      if (installed.pkgs.has(read.pkg) || (read.id !== null && installed.ids.has(read.id))) continue;
      out.push(read);
    }
    return out.sort((a, b) => (a.label ?? a.pkg).localeCompare(b.label ?? b.pkg));
  }

  /** An archive's bytes, as a browser uploads them. */
  stageUpload(archive: Buffer): PluginPreview {
    this.sweep();
    return this.stageArchive(archive, 'upload');
  }

  private stageArchive(archive: Buffer, origin: PluginOrigin): PluginPreview {
    if (archive.length > this.limits.maxArchiveBytes) {
      throw new PluginSourceError(413, 'too-large', 'archive is larger than the allowed size');
    }
    const zip = isZip(archive);
    if (!zip && (archive[0] !== GZIP_MAGIC[0] || archive[1] !== GZIP_MAGIC[1])) {
      throw new PluginSourceError(400, 'not-archive', 'not a plugin archive: expected a .tgz or a .zip');
    }
    const { token, root } = this.newSlot();
    try {
      const dir = join(root, 'package');
      if (zip) {
        this.extract(archive, dir, 'zip');
        return this.register({ token, root, dir, origin, format: 'archive', install: { kind: 'folder' } });
      }
      const file = join(root, 'archive.tgz');
      writeFileSync(file, archive);
      this.extract(archive, dir, 'tgz');
      return this.register({ token, root, dir, origin, format: 'archive', install: { kind: 'archive', file } });
    } catch (err) {
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * A path picked with the desktop's native dialog. Absolute, existing, not
   * inside the Rooks home (except the drop folder itself, which is the
   * `detected` source), and either a package folder, a `.tgz` or a `.zip`.
   */
  stagePath(raw: string): PluginPreview {
    this.sweep();
    if (!isAbsolute(raw) || raw.includes('\0') || raw.length > 4096) {
      throw new PluginSourceError(400, 'invalid-path', 'expected an absolute path');
    }
    let real: string;
    try { real = realpathSync.native(raw); } catch (err) {
      const denied = unreadable(err);
      throw denied instanceof PluginSourceError ? denied : new PluginSourceError(404, 'not-found', 'nothing at this path');
    }
    const inDropFolder = samePath(dirname(real), realRoot(this.pluginsRoot));
    // A zip there is no drop-folder candidate: read like any picked archive.
    if (inDropFolder && !ZIP_RE.test(real)) return this.stageDetected(basename(real));
    if (!inDropFolder && this.forbiddenRoots.some((root) => within(real, realRoot(root)))) {
      throw new PluginSourceError(400, 'forbidden-path', 'this folder is not a place a plugin is installed from');
    }
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(real); } catch (err) { throw unreadable(err); }
    if (stat.isFile()) {
      if (!ARCHIVE_RE.test(real) && !ZIP_RE.test(real)) {
        throw new PluginSourceError(400, 'not-a-plugin', 'expected a plugin folder, or a .tgz or .zip archive');
      }
      if (stat.size > this.limits.maxArchiveBytes) throw new PluginSourceError(413, 'too-large', 'archive is larger than the allowed size');
      let bytes: Buffer;
      try { bytes = readFileSync(real); } catch (err) { throw unreadable(err); }
      return this.stageArchive(bytes, 'path');
    }
    if (!stat.isDirectory() || !existsSync(join(real, 'package.json'))) {
      throw new PluginSourceError(400, 'not-a-plugin', 'expected a plugin folder (with a package.json), or a .tgz or .zip archive');
    }
    const { token, root } = this.newSlot();
    try {
      const dir = join(root, 'package');
      copyPackageFolder(real, dir, this.limits);
      const siblings = this.stageSiblings(real, dir, root);
      return this.register({ token, root, dir, origin: 'path', format: 'folder', install: { kind: 'folder' }, siblings });
    } catch (err) {
      rmSync(root, { recursive: true, force: true });
      throw unreadable(err);
    }
  }

  /** An entry of `candidates()`, named as the list named it. */
  stageDetected(name: string): PluginPreview {
    this.sweep();
    const entry = this.dropEntries().find((e) => e.name === name);
    if (!entry) throw new PluginSourceError(404, 'not-found', 'no such package in the plugins folder');
    const path = join(this.pluginsRoot, entry.name);
    if (entry.format === 'folder') {
      const token = randomBytes(24).toString('hex');
      return this.register({ token, root: null, dir: path, origin: 'detected', format: 'folder', install: { kind: 'in-place', path } });
    }
    const size = statSync(path).size;
    if (size > this.limits.maxArchiveBytes) throw new PluginSourceError(413, 'too-large', 'archive is larger than the allowed size');
    const { token, root } = this.newSlot();
    try {
      const dir = join(root, 'package');
      this.extract(readFileSync(path), dir, 'tgz');
      return this.register({ token, root, dir, origin: 'detected', format: 'archive', install: { kind: 'in-place', path } });
    } catch (err) {
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  }

  /** Throws away a preview nobody confirmed. Unknown tokens are a no-op. */
  discard(token: string): void {
    const staged = TOKEN_RE.test(token) ? this.staged.get(token) : undefined;
    if (!staged) return;
    this.staged.delete(token);
    if (staged.root) rmSync(staged.root, { recursive: true, force: true });
  }

  /** The confirmation click. Same `addPlugin` as `rooks plugin add`. */
  async installStaged(
    token: string,
    opts: { authorizeExec?: readonly string[]; authorizeExecChildren?: readonly ChildExecConsent[]; vault?: VaultConsent; vaultChildren?: readonly ChildVaultConsent[] } = {},
  ): Promise<AddResult & { vaultGranted: VaultGranted | null; vaultChildren: ChildVaultOutcome[] | null; authorizeExecChildren: ChildExecOutcome[] | null }> {
    this.sweep();
    const staged = TOKEN_RE.test(token) ? this.staged.get(token) : undefined;
    if (!staged) throw new PluginSourceError(404, 'expired', 'this preview has expired — pick the plugin again');
    if (staged.blocked) {
      throw new PluginSourceError(422, staged.blocked, staged.blocked === 'tampered'
        ? 'the signature does not match the files: this package was altered'
        : staged.blocked === 'node-engine' && staged.engineError
          ? staged.engineError
          : 'the plugin manifest is invalid');
    }
    // The grant is read from the STAGED manifest and re-resolved here: a
    // mismatch (409) aborts before anything is installed, and the preview stays.
    const parsed = readManifest(packageJsonOf(staged.dir));
    const configFile = this.opts.configFile ?? CONFIG_FILE;
    // Checked first, written last: a vault mismatch leaves no binary allowlisted.
    let vaultPlan: VaultGrantPlan | null = null;
    let childGrants: ChildGrant[] | null = null;
    let childExec: ChildExecGrant[] | null = null;
    const takenOver = parsed.ok && this.takesOver(parsed.manifest.id, staged.pkg, staged.dir);
    if (parsed.ok) {
      try {
        if (opts.vault !== undefined) vaultPlan = planVaultGrants(parsed.manifest, opts.vault, { takenOver });
        if (opts.vaultChildren !== undefined) childGrants = this.planChildren(staged, parsed.manifest, opts.vaultChildren);
        if (opts.authorizeExecChildren !== undefined) childExec = this.planChildExec(staged, parsed.manifest, opts.authorizeExecChildren);
      } catch (err) {
        if (err instanceof VaultGrantError) throw new PluginSourceError(err.status, err.code, err.message);
        if (err instanceof ExecGrantError) throw new PluginSourceError(err.status, err.code, err.message);
        throw err;
      }
    }
    let added: string[] = [];
    if (opts.authorizeExec !== undefined && parsed.ok) {
      try {
        added = (await grantProviderBinaries(parsed.manifest, opts.authorizeExec, configFile)).added;
      } catch (err) {
        if (err instanceof ExecGrantError) throw new PluginSourceError(err.status, err.code, err.message);
        throw err;
      }
      // The grant started programs, which takes time: a double click, or the expiry that removes the
      // staged folder, may have consumed this preview meanwhile. Same answer as if it came a moment later.
      if (this.staged.get(token) !== staged) {
        removeAllowEntries(added, configFile);
        throw new PluginSourceError(404, 'expired', 'this preview has expired — pick the plugin again');
      }
    }
    // Written before npm runs, so the plugin's first job already finds them.
    let vaultUndo: VaultGrantUndo | null = null;
    let vaultGranted: VaultGranted | null = null;
    if (vaultPlan) {
      try {
        // Now, not at the loader's next pass: that pass would take this consent
        // for what the previous package held, and withdraw it.
        if (takenOver && parsed.ok) {
          settlePluginPackage(vaultPlan.pluginId, {
            ...this.packageOf(staged.pkg, staged.dir),
            secretSettings: parsed.manifest.settings.filter((s) => s.type === 'secret').map((s) => s.key),
          }, configFile);
        }
        ({ undo: vaultUndo, granted: vaultGranted } = applyVaultGrants(vaultPlan, configFile));
      } catch (err) {
        removeAllowEntries(added, configFile);
        if (err instanceof VaultGrantError) throw new PluginSourceError(err.status, err.code, err.message);
        throw err;
      }
    }
    const rollback = (): void => {
      removeAllowEntries(added, configFile);
      if (vaultUndo) rollbackVaultGrants(vaultUndo, configFile);
    };
    // Consumed before npm runs: a double click must not install twice.
    this.staged.delete(token);
    try {
      const spec = this.persist(staged);
      const result = await addPlugin(spec, this.pluginsRoot, this.opts.install ?? {});
      // The plugin did not land: the authorization was for it, not for the machine.
      if (result.refused !== null) {
        rollback();
        return { ...result, vaultGranted: null, vaultChildren: null, authorizeExecChildren: null };
      }
      return {
        ...result,
        vaultGranted,
        vaultChildren: childGrants && this.grantChildren(childGrants, result, configFile),
        authorizeExecChildren: childExec && await this.grantChildExec(childExec, result, configFile),
      };
    } catch (err) {
      rollback();
      throw err;
    } finally {
      if (staged.root) rmSync(staged.root, { recursive: true, force: true });
    }
  }

  private packageOf(pkg: string, dir: string): PluginPackage {
    return { pkg, trust: verifyPluginDirectory(dir, this.keys).ok ? 'signed' : 'unsigned' };
  }

  /**
   * Installing this package takes the id from the one on record, which left the
   * disk. Another package still holding the id says nothing yet: two cannot share
   * it (`discoverPlugins`), and only the loader's pass knows which one stays. A
   * built-in always stays.
   */
  private takesOver(id: string, pkg: string, dir: string): boolean {
    const holder = discoverPlugins(this.pluginsRoot, this.opts.install?.builtins ?? resolveBuiltins())
      .find((d) => !('refusal' in d) && d.manifest.id === id);
    if (holder && (holder.builtin || holder.pkg !== pkg)) return false;
    return pluginPackageChanged(id, this.packageOf(pkg, dir));
  }

  /**
   * The bundle's children, read as `expandBundle` will find them, without npm:
   * a staged sibling, a folder of the drop folder a `file:` points at, or a copy
   * shipped in the package's `node_modules`. Parsed fields only, and a link
   * cannot take the read out of those places.
   */
  private readChildren(source: ChildSource, bundle: PluginManifest): ChildRead[] {
    const deps = packageJsonOf(source.dir)?.dependencies;
    const provided = new Map<string, { pkg: string; dir: string; json: unknown; version: string; manifest: PluginManifest }>();
    let unread = false;
    let count = 0;
    for (const [name, spec] of Object.entries(deps && typeof deps === 'object' ? deps as Record<string, unknown> : {})) {
      if (typeof spec !== 'string') continue;
      if (++count > MAX_BUNDLE_CHILDREN) { unread = true; break; }
      const dir = this.childFolder(source, name, spec);
      if (!dir) { unread = true; continue; }
      const json = packageJsonOf(dir);
      const res = json ? readManifest(json) : null;
      // A `models` pack a link takes out of the package: the loader refuses it like a bad manifest.
      if (!res?.ok || dictationModelsProblem(dir, res.manifest)) continue;
      // Last one wins, as in `expandBundle`.
      provided.set(res.manifest.id, { pkg: name, dir, json, version: typeof json?.version === 'string' ? json.version : '0.0.0', manifest: res.manifest });
    }
    const installed = this.installedIndex().ids;
    const empty = { pkg: null, version: null, label: null, permissions: [], signature: null, vault: null, provider: null, dictation: null, replaces: null, engineError: null };
    const runtime = this.opts.install?.runtime ?? currentNodeRuntime();
    return [...new Set(bundle.contains)].map((id): ChildRead => {
      if (id === bundle.id) return { preview: { ...empty, id, state: 'unresolved' }, manifest: null, takenOver: false };
      if (installed.has(id)) return { preview: { ...empty, id, state: 'kept' }, manifest: null, takenOver: false };
      const child = provided.get(id);
      if (!child) return { preview: { ...empty, id, state: unread ? 'unreadable' : 'unresolved' }, manifest: null, takenOver: false };
      const signature = this.signatureOf(child.dir);
      // The loader's rule, as for the package itself: only a host half runs on the daemon's Node.
      const engineError = hasHostHalf(child.dir, child.json, child.manifest)
        ? nodeEngineProblem(child.json, id, runtime)
        : null;
      const loads = signature.state !== 'tampered' && !engineError;
      // A child that will not load takes the id from nobody.
      const takenOver = loads && this.takesOver(id, child.pkg, child.dir);
      return {
        manifest: child.manifest,
        takenOver,
        preview: {
          id,
          pkg: child.pkg,
          version: child.version,
          label: child.manifest.label ?? null,
          state: 'install',
          permissions: [...child.manifest.permissions],
          signature,
          vault: loads ? pluginVaultRequests(child.manifest, { takenOver }) : null,
          provider: loads ? providerPreview(child.manifest) : null,
          dictation: loads ? dictationPreview(child.manifest) : null,
          replaces: takenOver ? boundPluginPackage(id)?.pkg ?? null : null,
          engineError,
        },
      };
    });
  }

  /** The folder to read a dependency's manifest from; `null` when npm alone could say. */
  private childFolder(source: ChildSource, name: string, spec: string): string | null {
    if (RELATIVE_LOCAL_SPEC.test(spec)) {
      const rel = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
      // Only directly inside the plugins folder: the only place a sibling lands (`persistSibling`).
      const dest = resolve(this.pluginsRoot, '_', rel);
      if (samePath(dirname(dest), this.pluginsRoot)) {
        const sibling = source.siblings?.find((s) => s.pkg === name);
        if (sibling) return sibling.dir;
        const pathResolves = source.install.kind === 'folder' || (source.install.kind === 'in-place' && source.format === 'folder');
        if (pathResolves) {
          const inDrop = realFolderWithin(dest, this.pluginsRoot);
          if (inDrop) return inDrop;
        }
      }
    }
    return realFolderWithin(join(source.dir, 'node_modules', name), source.dir);
  }

  private signatureOf(dir: string): SignatureVerdict {
    const verdict = verifyPluginDirectory(dir, this.keys);
    if (verdict.ok) return { state: 'signed', keyId: verdict.signature.keyId };
    return verdict.code === 'tampered' ? { state: 'tampered' } : { state: 'unsigned', loads: this.unsignedLoads() };
  }

  /** Checks a child's consent against what the staged package says now; writes nothing. */
  private planChildren(source: ChildSource, manifest: PluginManifest, consent: readonly ChildVaultConsent[]): ChildGrant[] {
    const children = manifest.kind.includes('bundle') ? this.readChildren(source, manifest) : [];
    const named = children.flatMap(({ preview, manifest: m, takenOver }) => (
      preview.state === 'install' && preview.vault && m && preview.pkg !== null && preview.version !== null && preview.signature
        ? [{ id: preview.id, pkg: preview.pkg, version: preview.version, signature: signatureKey(preview.signature), manifest: m, takenOver }]
        : []
    ));
    const plans = planChildVaultGrants(named, consent);
    return named.map((child, index) => ({
      id: child.id, pkg: child.pkg, version: child.version, signature: child.signature,
      requests: vaultRequestsKey(child.manifest), takenOver: child.takenOver, plan: plans[index]!,
    }));
  }

  /**
   * Written once the child is on disk and only if it is what was shown, unlike
   * the plugin's own lines: `name@range` comes from the registry whatever copy
   * the package ships, and a `file:` may meet another package in the plugins
   * folder. The consent was for that package, so a different one gets nothing.
   * A plugin already copes with a grant arriving later (the Secrets page does it).
   * A child taking the id from another package settles it first, as `installStaged`
   * does for the package itself: the loader's next pass would otherwise take this
   * consent for what the previous package held, and withdraw it (TODO #684).
   */
  private grantChildren(grants: readonly ChildGrant[], result: AddResult, configFile: string): ChildVaultOutcome[] {
    const landed = discoverPlugins(this.pluginsRoot);
    return grants.map((grant): ChildVaultOutcome => {
      if (result.children.find((c) => c.id === grant.id)?.state !== 'installed') {
        return { id: grant.id, granted: null, refused: 'not-installed' };
      }
      const found = landed.find((d) => !('refusal' in d) && d.manifest.id === grant.id);
      const same = found && !('refusal' in found)
        && found.pkg === grant.pkg
        && found.version === grant.version
        && signatureKey(this.signatureOf(found.dir)) === grant.signature
        && vaultRequestsKey(found.manifest) === grant.requests;
      if (!same) return { id: grant.id, granted: null, refused: 'changed' };
      // `false` with a takeover on the sheet: a loader pass already settled it while npm ran.
      const takesOver = this.takesOver(grant.id, found.pkg, found.dir);
      // Another package bound the id since the sheet: what it showed as granted is that one's.
      if (takesOver && !grant.takenOver) return { id: grant.id, granted: null, refused: 'changed' };
      try {
        if (takesOver) {
          settlePluginPackage(grant.id, {
            ...this.packageOf(found.pkg, found.dir),
            secretSettings: found.manifest.settings.filter((s) => s.type === 'secret').map((s) => s.key),
          }, configFile);
        }
        return { id: grant.id, granted: applyVaultGrants(grant.plan, configFile).granted, refused: null };
      } catch (err) {
        console.warn(`[plugins] vault grants of ${grant.id}: ${(err as Error).message}`);
        return { id: grant.id, granted: null, refused: 'grant-failed' };
      }
    });
  }

  /**
   * Checks the programs accepted per child against what the staged package says
   * now; writes nothing. Unlike `vaultChildren`, a child may be left out: accepting
   * a provider's programs is its own act, off until the person ticks it. A line for
   * anything else than a provider of the sheet (a child kept, unreadable, broken,
   * another package) is a mismatch, never a path allowlisted on its own.
   */
  private planChildExec(source: ChildSource, manifest: PluginManifest, consent: readonly ChildExecConsent[]): ChildExecGrant[] {
    const children = manifest.kind.includes('bundle') ? this.readChildren(source, manifest) : [];
    const mismatch = (): ExecGrantError =>
      new ExecGrantError('mismatch', 'the plugins this bundle brings changed since they were shown — review them again', 409);
    if (new Set(consent.map((line) => line.id)).size !== consent.length) throw mismatch();
    return consent.map((line) => {
      const child = children.find((c) => c.preview.id === line.id);
      const { preview, manifest: m } = child ?? {};
      if (!preview || !m || preview.state !== 'install' || !preview.provider || !preview.signature
        || preview.pkg !== line.pkg || preview.version !== line.version) throw mismatch();
      checkProviderBinaries(m, line.paths);
      return {
        id: line.id, pkg: line.pkg, version: line.version, signature: signatureKey(preview.signature),
        provider: providerKey(m), paths: line.paths,
      };
    });
  }

  /**
   * Same rule as `grantChildren`: written once the child is on disk and only if
   * it is what was shown. Not before npm, as for a provider installed alone: the
   * path is allowlisted for every plugin holding `host:exec`, on the word of a
   * sheet that may have described another package. The loader watches the config
   * file, so a child that failed on the allowlist in the meantime mounts on its own.
   */
  private async grantChildExec(grants: readonly ChildExecGrant[], result: AddResult, configFile: string): Promise<ChildExecOutcome[]> {
    const landed = discoverPlugins(this.pluginsRoot);
    const outcomes: ChildExecOutcome[] = [];
    for (const grant of grants) outcomes.push(await (async (): Promise<ChildExecOutcome> => {
      if (result.children.find((c) => c.id === grant.id)?.state !== 'installed') {
        return { id: grant.id, granted: null, refused: 'not-installed' };
      }
      const found = landed.find((d) => !('refusal' in d) && d.manifest.id === grant.id);
      if (!found || 'refusal' in found
        || found.pkg !== grant.pkg
        || found.version !== grant.version
        || signatureKey(this.signatureOf(found.dir)) !== grant.signature
        || providerKey(found.manifest) !== grant.provider) {
        return { id: grant.id, granted: null, refused: 'changed' };
      }
      try {
        // Resolved again: the program may have moved while npm ran.
        return { id: grant.id, granted: (await grantProviderBinaries(found.manifest, grant.paths, configFile)).granted, refused: null };
      } catch (err) {
        if (err instanceof ExecGrantError) return { id: grant.id, granted: null, refused: 'changed' };
        console.warn(`[plugins] binaries of ${grant.id}: ${(err as Error).message}`);
        return { id: grant.id, granted: null, refused: 'grant-failed' };
      }
    })());
    return outcomes;
  }

  /** Where the confirmed package lives for good, inside the plugins folder. */
  private persist(staged: Staged): string {
    if (staged.install.kind === 'in-place') return staged.install.path;
    mkdirSync(this.pluginsRoot, { recursive: true });
    const base = safeName(staged.pkg);
    if (staged.install.kind === 'archive') {
      const file = join(this.pluginsRoot, `${base}-${safeName(staged.version)}.tgz`);
      cpSync(staged.install.file, file);
      return file;
    }
    const target = persistFolder(this.pluginsRoot, staged.dir, staged.pkg, staged.version);
    for (const sibling of staged.siblings ?? []) this.persistSibling(target, sibling);
    return target;
  }

  /**
   * The local dependencies a picked folder declares (`file:../plugin-page`,
   * the children of a bundle laid out side by side), copied into the staging
   * slot. Only the picked folder is copied otherwise, and once it lands in the
   * plugins folder those relative paths point at nothing: the bundle's
   * children came back `unresolved`, where `rooks plugin add ./bundle` found
   * them. One level, the same caps as the folder, the same forbidden roots,
   * and a dependency that cannot be read is skipped — npm and the bundle's
   * report then say so, as before.
   */
  private stageSiblings(real: string, dir: string, root: string): StagedSibling[] {
    const deps = packageJsonOf(dir)?.dependencies;
    if (!deps || typeof deps !== 'object') return [];
    const out: StagedSibling[] = [];
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (out.length >= MAX_SIBLINGS) break;
      if (typeof spec !== 'string' || !RELATIVE_LOCAL_SPEC.test(spec)) continue;
      const rel = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
      let src: string;
      try { src = realpathSync.native(resolve(real, rel)); } catch { continue; }
      if (samePath(src, real) || this.forbiddenRoots.some((r) => within(src, realRoot(r)))) continue;
      if (packageJsonOf(src)?.name !== name) continue;
      const dest = join(root, 'siblings', String(out.length));
      try { copyPackageFolder(src, dest, this.limits); } catch { rmSync(dest, { recursive: true, force: true }); continue; }
      out.push({ dir: dest, pkg: name, rel });
    }
    return out;
  }

  /**
   * Lays a staged sibling where `rel` points from the installed package — only
   * directly inside the plugins folder (a deeper or outer path is not ours to
   * write), and never over another package's folder.
   */
  private persistSibling(target: string, sibling: StagedSibling): void {
    const dest = resolve(target, sibling.rel);
    if (!samePath(dirname(dest), this.pluginsRoot) || samePath(dest, target)) return;
    if (existsSync(dest) && packageJsonOf(dest)?.name !== sibling.pkg) return;
    rmSync(dest, { recursive: true, force: true });
    cpSync(sibling.dir, dest, { recursive: true });
  }

  /**
   * `rooks plugin add <file.zip>`: npm cannot read a zip, so it is extracted
   * and laid in the plugins folder exactly as the gallery does, then handed
   * to the same `addPlugin`. `folder` is that copy, for the CLI to remove if
   * the user declines.
   */
  async addZipFile(file: string): Promise<{ result: AddResult; folder: string }> {
    this.sweep();
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(file); } catch (err) {
      const denied = unreadable(err);
      throw denied instanceof PluginSourceError ? denied : new PluginSourceError(404, 'not-found', 'nothing at this path');
    }
    if (!stat.isFile()) throw new PluginSourceError(400, 'not-a-plugin', 'expected a .zip archive');
    if (stat.size > this.limits.maxArchiveBytes) throw new PluginSourceError(413, 'too-large', 'archive is larger than the allowed size');
    let archive: Buffer;
    try { archive = readFileSync(file); } catch (err) { throw unreadable(err); }
    const { root } = this.newSlot();
    try {
      const dir = join(root, 'package');
      this.extract(archive, dir, 'zip');
      const json = packageJsonOf(dir);
      const pkg = typeof json?.name === 'string' && json.name ? json.name : null;
      if (!pkg) throw new PluginSourceError(400, 'not-a-plugin', 'package.json has no `name`');
      const version = typeof json?.version === 'string' ? json.version : '0.0.0';
      const folder = persistFolder(this.pluginsRoot, dir, pkg, version);
      try {
        return { result: await addPlugin(folder, this.pluginsRoot, this.opts.install ?? {}), folder };
      } catch (err) {
        // Refused before npm: the copy would linger in the drop folder as "available".
        if (err instanceof PluginEngineError) rmSync(folder, { recursive: true, force: true });
        throw err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  private extract(archive: Buffer, dir: string, format: 'tgz' | 'zip'): void {
    try {
      if (format === 'zip') extractZip(archive, dir, this.limits);
      else extractTarGz(archive, dir, this.limits);
    } catch (err) {
      if (err instanceof TarError || err instanceof ZipError) {
        throw new PluginSourceError(err.code === 'too-large' || err.code === 'too-many-entries' ? 413 : 400, err.code, err.message);
      }
      throw err;
    }
  }

  private newSlot(): { token: string; root: string } {
    const token = randomBytes(24).toString('hex');
    const root = join(this.stagingRoot, token);
    mkdirSync(root, { recursive: true });
    return { token, root };
  }

  private register(input: Omit<Staged, 'createdAt' | 'pkg' | 'version' | 'blocked' | 'engineError'>): PluginPreview {
    const preview = this.preview(input.token, input, input.origin, input.format);
    this.staged.set(input.token, { ...input, createdAt: this.now(), pkg: preview.pkg, version: preview.version, blocked: preview.blocked, engineError: preview.engineError });
    while (this.staged.size > MAX_STAGED) {
      const oldest = this.staged.keys().next().value;
      if (oldest === undefined) break;
      this.discard(oldest);
    }
    return preview;
  }

  private sweep(): void {
    const limit = this.now() - TTL_MS;
    for (const [token, staged] of [...this.staged]) {
      if (staged.createdAt < limit) this.discard(token);
    }
    // Leftovers of a daemon that stopped mid-preview: nothing references them.
    if (!existsSync(this.stagingRoot)) return;
    for (const name of readdirSync(this.stagingRoot)) {
      if (this.staged.has(name)) continue;
      const path = join(this.stagingRoot, name);
      try {
        if (statSync(path).mtimeMs < limit) rmSync(path, { recursive: true, force: true });
      } catch { /* raced with another sweep */ }
    }
  }

  private preview(token: string, source: ChildSource, origin: PluginOrigin, format: 'archive' | 'folder'): PluginPreview {
    const { dir } = source;
    const json = packageJsonOf(dir);
    if (!json) throw new PluginSourceError(400, 'not-a-plugin', 'no readable package.json in this package');
    const pkg = typeof json.name === 'string' && json.name ? json.name : null;
    if (!pkg) throw new PluginSourceError(400, 'not-a-plugin', 'package.json has no `name`');
    const version = typeof json.version === 'string' ? json.version : '0.0.0';
    const res = readManifest(json);
    // A `models` pack a link takes out of the package is refused like a bad manifest:
    // the form of the path was checked, not where it leads.
    const modelsProblem = res.ok ? dictationModelsProblem(dir, res.manifest) : null;
    const manifest: PluginManifest | null = res.ok && !modelsProblem ? res.manifest : null;
    const signature = this.signatureOf(dir);
    const installed = this.installedVersion(pkg, manifest?.id ?? null);
    // The daemon's own Node is this process's: it is the one that will import the host half.
    const engineError = manifest && hasHostHalf(dir, json, manifest)
      ? nodeEngineProblem(json, manifest.id, this.opts.install?.runtime ?? currentNodeRuntime())
      : null;
    const blocked = !manifest ? 'manifest' : signature.state === 'tampered' ? 'tampered' : engineError ? 'node-engine' : null;
    const takenOver = manifest !== null && this.takesOver(manifest.id, pkg, dir);
    return {
      token,
      origin,
      format,
      pkg,
      version,
      id: manifest?.id ?? null,
      label: manifest?.label ?? null,
      description: manifest?.description ?? null,
      author: manifest?.author ?? null,
      kind: manifest?.kind ?? [],
      permissions: [...(manifest?.permissions ?? [])],
      slots: manifest?.client?.slots ?? [],
      route: manifest?.route ?? null,
      declares: manifest?.declares ?? {},
      modifies: manifest?.modifies ?? [],
      contains: manifest?.contains ?? [],
      settings: (manifest?.settings ?? []).map((s) => s.label),
      webhooks: (manifest?.webhooks ?? []).map((w) => w.name),
      provider: manifest ? providerPreview(manifest) : null,
      dictation: manifest ? dictationPreview(manifest) : null,
      vault: manifest ? pluginVaultRequests(manifest, { takenOver }) : null,
      children: manifest?.kind.includes('bundle') ? this.readChildren(source, manifest).map((c) => c.preview) : [],
      licenseRequired: manifest?.license.required ?? false,
      icon: manifest?.icon ? inlineImage(dir, manifest.icon, ICON_MAX_BYTES) : null,
      cover: manifest?.cover ? inlineImage(dir, manifest.cover, COVER_MAX_BYTES) : null,
      signature,
      manifestError: res.ok ? modelsProblem : res.message,
      engineError,
      installed,
      replaces: takenOver ? boundPluginPackage(manifest.id)?.pkg ?? null : null,
      updatesUnsigned: manifest !== null && signature.state === 'signed'
        && signsUnsignedCopy(boundPluginPackage(manifest.id), { pkg, trust: 'signed' }),
      installable: blocked === null,
      blocked,
    };
  }

  private installedIndex(): { pkgs: Set<string>; ids: Set<string>; versions: Map<string, string> } {
    const pkgs = new Set(installedPackages(this.pluginsRoot));
    const ids = new Set<string>();
    const versions = new Map<string, string>();
    for (const d of discoverPlugins(this.pluginsRoot)) {
      versions.set(d.pkg, d.version);
      if (!('refusal' in d)) {
        ids.add(d.manifest.id);
        versions.set(`id:${d.manifest.id}`, d.version);
      }
    }
    return { pkgs, ids, versions };
  }

  private installedVersion(pkg: string, id: string | null): { version: string } | null {
    const index = this.installedIndex();
    const version = index.versions.get(pkg) ?? (id ? index.versions.get(`id:${id}`) : undefined);
    return version === undefined ? null : { version };
  }

  /** Top-level entries of the drop folder that may hold a package. */
  private dropEntries(): Array<{ name: string; format: 'archive' | 'folder' }> {
    if (!existsSync(this.pluginsRoot)) return [];
    const out: Array<{ name: string; format: 'archive' | 'folder' }> = [];
    for (const entry of readdirSync(this.pluginsRoot, { withFileTypes: true })) {
      if (out.length >= MAX_SCANNED) break;
      if (entry.name.startsWith('.') || SKIPPED_NAMES.has(entry.name)) continue;
      // `withFileTypes` reports the link itself: a symlink is neither, and skipped.
      if (entry.isDirectory() && existsSync(join(this.pluginsRoot, entry.name, 'package.json'))) {
        out.push({ name: entry.name, format: 'folder' });
      } else if (entry.isFile() && ARCHIVE_RE.test(entry.name)) {
        out.push({ name: entry.name, format: 'archive' });
      }
    }
    return out;
  }

  private readCandidate(name: string, format: 'archive' | 'folder'): PluginCandidate | null {
    if (format === 'folder') return this.readCandidateUncached(name, format);
    let stamp: string;
    try {
      const st = statSync(join(this.pluginsRoot, name));
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch { return null; }
    const cached = this.candidateCache.get(name);
    if (cached?.stamp === stamp) return cached.read;
    const read = this.readCandidateUncached(name, format);
    this.candidateCache.set(name, { stamp, read });
    if (this.candidateCache.size > MAX_SCANNED) this.candidateCache.delete(this.candidateCache.keys().next().value as string);
    return read;
  }

  private readCandidateUncached(name: string, format: 'archive' | 'folder'): PluginCandidate | null {
    const path = join(this.pluginsRoot, name);
    let json: Record<string, unknown> | null = null;
    try {
      if (format === 'folder') {
        json = packageJsonOf(path);
      } else {
        if (statSync(path).size > this.limits.maxArchiveBytes) return null;
        const entry = readTarGz(readFileSync(path), this.limits).find((e) => e.path === 'package.json' && e.type === 'file');
        json = entry ? parseObject(entry.data.toString('utf8')) : null;
      }
    } catch { return null; }
    if (!json || typeof json.name !== 'string' || !json.name) return null;
    const res = readManifest(json);
    // Not a Rooks plugin at all (no `rooks` field): not ours to list.
    if (!res.ok && res.code === 'manifest' && !('rooks' in json)) return null;
    return {
      name,
      format,
      pkg: json.name,
      version: typeof json.version === 'string' ? json.version : '0.0.0',
      id: res.ok ? res.manifest.id : null,
      label: res.ok ? res.manifest.label ?? null : null,
      description: res.ok ? res.manifest.description ?? null : null,
      kind: res.ok ? res.manifest.kind : [],
    };
  }
}

/** A root as the OS names it: `realpath` when it exists (macOS `/var` → `/private/var`, links, junctions). */
function realRoot(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** Path comparison, case-insensitive where the file system usually is (Windows). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function within(child: string, root: string): boolean {
  if (samePath(child, root)) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return process.platform === 'win32'
    ? child.toLowerCase().startsWith(prefix.toLowerCase())
    : child.startsWith(prefix);
}

/** `path` once links are resolved, if it is a package folder still inside `root`; `null` otherwise. */
function realFolderWithin(path: string, root: string): string | null {
  try {
    const real = realpathSync.native(path);
    const base = realRoot(root);
    if (samePath(real, base) || !within(real, base)) return null;
    return existsSync(join(real, 'package.json')) ? real : null;
  } catch { return null; }
}

function providerPreview(manifest: PluginManifest): PluginPreview['provider'] {
  if (!manifest.kind.includes('provider')) return null;
  return {
    binaries: providerBinaryRequests(manifest),
    osCredentials: [...(manifest.provider?.osCredentials ?? [])],
    credentialDirs: [...(manifest.provider?.credentialDirs ?? [])],
  };
}

function dictationPreview(manifest: PluginManifest): PluginPreview['dictation'] {
  if (!manifest.kind.includes('dictation') || !manifest.dictation) return null;
  return {
    engines: manifest.dictation.engines.map((e) => ({ ...e, egress: Array.isArray(e.egress) ? [...e.egress] : e.egress })),
    models: manifest.dictation.models ?? null,
    lines: dictationEgressLines(manifest),
  };
}

/** What a manifest says of its programs, comparable between the previewed child and the one npm laid down. */
function providerKey(manifest: PluginManifest): string {
  return JSON.stringify({ kind: manifest.kind.includes('provider'), provider: manifest.provider ?? null });
}

/** A verdict as a comparable string: the same key, or the same absence of one. */
function signatureKey(verdict: SignatureVerdict): string {
  return verdict.state === 'signed' ? `signed:${verdict.keyId}` : verdict.state;
}

/** A source the daemon may not read (macOS privacy prompts, Windows ACLs): said as such, not as a crash. */
function unreadable(err: unknown): unknown {
  const code = (err as { code?: string }).code;
  return code === 'EACCES' || code === 'EPERM'
    ? new PluginSourceError(400, 'unreadable', 'Rooks is not allowed to read this location')
    : err;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** `package.json` of a package folder, refusing one that is a link out of it. */
function packageJsonOf(dir: string): Record<string, unknown> | null {
  const file = confinedFile(dir, 'package.json');
  if (!file) return null;
  try { return parseObject(readFileSync(file, 'utf8')); } catch { return null; }
}

/** `rel` inside `dir`, after links are resolved; `null` when it escapes or is not a file. */
function confinedFile(dir: string, rel: string): string | null {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(resolve(dir, rel));
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

/** An icon or cover the manifest declares, as a `data:` URL; `null` if refused. */
function inlineImage(dir: string, declared: string, maxBytes: number): string | null {
  const resolved = resolveCoverFile(dir, declared);
  if (!resolved.ok) return null;
  const file = confinedFile(dir, relative(dir, resolved.file));
  if (!file) return null;
  const size = statSync(file).size;
  if (size > maxBytes) return null;
  const bytes = readFileSync(file);
  // Same encoding as the bundled pictos (`data:image/svg+xml,`), which the
  // gallery's mask already accepts; raster covers go base64.
  if (resolved.contentType === 'image/svg+xml') return `data:image/svg+xml,${encodeURIComponent(bytes.toString('utf8'))}`;
  return `data:${resolved.contentType};base64,${bytes.toString('base64')}`;
}

/**
 * A package folder laid in the plugins folder for npm to link. A folder of the
 * same name is replaced only when it holds the same package (a new version of
 * it); anything else the user put there stays.
 */
function persistFolder(pluginsRoot: string, dir: string, pkg: string, version: string): string {
  mkdirSync(pluginsRoot, { recursive: true });
  const base = safeName(pkg);
  let target = join(pluginsRoot, base);
  if (existsSync(target) && packageJsonOf(target)?.name !== pkg) {
    target = join(pluginsRoot, `${base}-${safeName(version)}`);
    if (existsSync(target) && packageJsonOf(target)?.name !== pkg) {
      throw new PluginSourceError(409, 'name-taken', 'a different package already uses this folder name in the plugins folder');
    }
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(dir, target, { recursive: true });
  return target;
}

/** `@acme/foo` → `acme-foo`: a file name on every OS, never a path. */
function safeName(value: string): string {
  const cleaned = value.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return cleaned || 'plugin';
}

/**
 * Copies a package folder verbatim — the signature covers every file, so
 * nothing is skipped. A link anywhere is refused (it could reach outside the
 * folder, and a signed plugin cannot hold one), and the same caps as an
 * archive apply.
 */
export function copyPackageFolder(src: string, dest: string, limits: TarLimits = DEFAULT_TAR_LIMITS): void {
  let entries = 0;
  let bytes = 0;
  const walk = (from: string, to: string, depth: number): void => {
    if (depth > 32) throw new PluginSourceError(400, 'too-deep', 'plugin folder is nested too deeply');
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (++entries > limits.maxEntries) throw new PluginSourceError(413, 'too-many-entries', 'plugin folder has too many files');
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new PluginSourceError(400, 'link', 'plugin folder contains a link — not allowed in a plugin');
      if (stat.isDirectory()) { walk(source, target, depth + 1); continue; }
      if (!stat.isFile()) throw new PluginSourceError(400, 'link', 'plugin folder contains a special file');
      bytes += stat.size;
      if (bytes > limits.maxExpandedBytes) throw new PluginSourceError(413, 'too-large', 'plugin folder is larger than the allowed size');
      cpSync(source, target);
    }
  };
  walk(src, dest, 0);
}
