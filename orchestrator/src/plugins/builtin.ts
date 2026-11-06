/**
 * Built-in plugins: SDK packages shipped INSIDE the product, next to the
 * daemon, instead of installed by the user under `~/.timon/plugins/`.
 *
 * They are ordinary third-party packages — same manifest, same façade, same
 * browser half — whose trust comes from WHERE they live rather than from a
 * signature: they are part of the release, so they run offline and whatever
 * the licence (a fixed composition included). Disabling them goes through
 * `plugins[<id>] = false`, like any plugin; removing them is not possible,
 * the installer owns their files.
 *
 * ## One list, two layouts
 *
 * `builtin-plugins.json`, at the root of the orchestrator package, is the only
 * list. The desktop packaging reads it too
 * (`desktop/scripts/prepare-daemon-release.mjs`), which copies each entry to
 * `builtin-plugins/<npm name>/` and ships the list beside it.
 *
 *  - **Packaged** (a `release-manifest.json` sits at the root): the package is
 *    read from `<root>/builtin-plugins/<npm name>/`.
 *  - **Source tree** (daemon run from the repository): from `source`, relative
 *    to the orchestrator root — the example package itself, never a copy.
 *
 * ## Trust by location, bounded by the signed release
 *
 * In a packaged build the location is only trusted when every file of the
 * plugin is listed, with the same digest, in the release manifest that
 * `dist/boot.js` verified before the daemon's first import (it hands the
 * verified inventory over through `RELEASE_MARKER`). Anything else — an
 * altered file, one the manifest does not know, one it lists but is gone, a
 * boot that did not go through the verification — and the package is judged
 * like any third-party one: signature, licence, composition.
 *
 * Checked on every reconciliation, not once: boot verified the files at
 * startup, but the loader remounts a plugin whose files change while the
 * daemon runs.
 *
 * The source tree has no signed inventory to hold it against, so what it is
 * trusted for is narrower than "whatever the list says":
 *
 *  - it must BE a source checkout (`src/plugins/builtin.ts` beside the list).
 *    A packaged tree whose `release-manifest.json` went missing is not one: it
 *    ships no `src/`, so deleting the manifest does not turn it into a tree
 *    that trusts itself;
 *  - each `source` of the list must stay inside the checkout and outside the
 *    folder plugins are installed into (`PLUGINS_DIR`), symbolic links resolved.
 *    Nothing a user installed can be reached through the list.
 *
 * Both layouts keep the other half of the rule: a plugin installed under
 * `~/.timon/plugins/` is never read from the list, so it is never a built-in
 * (`loader.ts` reads the built-ins first and tags them by where they came from,
 * not by an id).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PLUGINS_DIR } from '../paths.js';

/** Set by the packaged `dist/boot.js` once `verifyRelease` has passed. */
export const RELEASE_MARKER = Symbol.for('timon.verifiedRelease');

/** The inventory `verifyRelease` accepted: product-relative path → sha256. */
export type VerifiedRelease = { files: Readonly<Record<string, string>> };

export type BuiltinTrust = { ok: true } | { ok: false; message: string };

export type ResolvedBuiltin = {
  /** Npm package name, also the directory under `builtin-plugins/`. */
  pkg: string;
  dir: string;
  trust: BuiltinTrust;
  /**
   * `false`: shipped switched off, the user turns it on (`plugins[<id>] = true`).
   * Absent means on, like every other plugin. An explicit setting wins.
   */
  enabledByDefault?: boolean;
};

/** Folder of the packaged copies, relative to the orchestrator root. */
export const BUILTIN_DIR = 'builtin-plugins';
export const BUILTIN_LIST = 'builtin-plugins.json';

const ListSchema = z.object({
  plugins: z.array(z.object({
    // A scoped npm name at most: `builtin-plugins/<pkg>` must stay inside its folder.
    pkg: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
    source: z.string().min(1),
    enabledByDefault: z.boolean().optional(),
  })),
});

/** `<root>/dist/plugins/builtin.js` compiled, `<root>/src/plugins/builtin.ts` under tsx. */
export function orchestratorRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** A source checkout of the repository, as opposed to a packaged tree (which ships no `src/`). */
export function isSourceTree(root: string): boolean {
  return existsSync(join(root, 'src', 'plugins', 'builtin.ts'));
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Why a `source` of the list cannot be trusted in a source checkout, or `null`. */
function sourceProblem(root: string, dir: string): string | null {
  const repo = realOrSelf(dirname(root));
  const real = realOrSelf(dir);
  if (!inside(repo, real)) return `${dir} is outside the source checkout`;
  if (inside(realOrSelf(PLUGINS_DIR), real)) return `${dir} lies in the folder plugins are installed into`;
  return null;
}

/** The list is part of the signed inventory in a release: an edited one selects nothing. */
function listProblem(root: string, release: VerifiedRelease): string | null {
  const file = join(root, BUILTIN_LIST);
  if (!existsSync(file)) return null;
  const expected = release.files[BUILTIN_LIST];
  if (expected === undefined) return `${BUILTIN_LIST} is not covered by the release manifest`;
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  return digest === expected ? null : `${BUILTIN_LIST} does not match the release manifest`;
}

export function readBuiltinList(root: string = orchestratorRoot()): z.infer<typeof ListSchema>['plugins'] {
  const file = join(root, BUILTIN_LIST);
  if (!existsSync(file)) return [];
  try {
    const parsed = ListSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.success) return parsed.data.plugins;
    console.warn(`[plugins] invalid ${file} — built-in plugins ignored`);
  } catch (err) {
    console.warn(`[plugins] cannot read ${file}: ${(err as Error).message}`);
  }
  return [];
}

/** The inventory handed over by the packaged boot, `null` anywhere else. */
export function verifiedRelease(): VerifiedRelease | null {
  const value: unknown = (globalThis as Record<symbol, unknown>)[RELEASE_MARKER];
  if (typeof value !== 'object' || value === null) return null;
  const files = (value as { files?: unknown }).files;
  if (typeof files !== 'object' || files === null) return null;
  return { files: files as Record<string, string> };
}

function listFiles(dir: string, rel: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const relName = `${rel}/${name}`; // portability: manifest keys always use `/`
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`${relName} is a symbolic link`);
    if (stat.isDirectory()) listFiles(path, relName, out);
    else if (stat.isFile()) out.push(relName);
    else throw new Error(`${relName} is not a regular file`);
  }
}

/**
 * Every file under `dir` must be in `release.files` under `prefix`, with the
 * same digest, and every manifest entry under `prefix` must exist.
 */
export function verifyBuiltinFiles(dir: string, prefix: string, release: VerifiedRelease | null): BuiltinTrust {
  if (!release) return { ok: false, message: 'the release manifest was not verified at boot' };
  const actual: string[] = [];
  try {
    listFiles(dir, prefix, actual);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  const expected = Object.keys(release.files).filter((name) => name.startsWith(`${prefix}/`)).sort(); // portability: manifest keys, not a path
  if (expected.length === 0) return { ok: false, message: `${prefix} is not covered by the release manifest` };
  const extra = actual.find((name) => !(name in release.files));
  if (extra) return { ok: false, message: `${extra} is not covered by the release manifest` };
  const missing = expected.find((name) => !actual.includes(name));
  if (missing) return { ok: false, message: `${missing} is listed in the release manifest but missing` };
  for (const name of actual) {
    const file = join(dir, ...name.slice(prefix.length + 1).split('/'));
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (digest !== release.files[name]) return { ok: false, message: `${name} does not match the release manifest` };
  }
  return { ok: true };
}

export type ResolveBuiltinsOptions = {
  root?: string;
  /** Injected by tests; the daemon reads the boot marker. */
  release?: VerifiedRelease | null;
};

/**
 * Resolves the list against the running layout. Tests inject `root` and
 * `release`; the daemon calls it bare, on every reconciliation.
 */
export function resolveBuiltins(opts: ResolveBuiltinsOptions = {}): ResolvedBuiltin[] {
  const root = opts.root ?? orchestratorRoot();
  const release = opts.release === undefined ? verifiedRelease() : opts.release;
  const packaged = release !== null || existsSync(join(root, 'release-manifest.json'));
  const list = readBuiltinList(root);
  if (packaged) {
    const listMessage = release ? listProblem(root, release) : null;
    return list.map(({ pkg, source: _source, enabledByDefault }) => {
      const off = enabledByDefault === false ? { enabledByDefault: false } : {};
      const dir = join(root, BUILTIN_DIR, ...pkg.split('/'));
      const trust: BuiltinTrust = listMessage
        ? { ok: false, message: listMessage }
        : verifyBuiltinFiles(dir, `${BUILTIN_DIR}/${pkg}`, release); // portability: manifest key prefix, not a path
      return { pkg, dir, trust, ...off };
    });
  }
  const checkout = isSourceTree(root);
  return list.map(({ pkg, source, enabledByDefault }) => {
    const off = enabledByDefault === false ? { enabledByDefault: false } : {};
    const dir = resolve(root, source);
    const problem = checkout ? sourceProblem(root, dir) : `${root} is not a source checkout and carries no verified release manifest`;
    const trust: BuiltinTrust = problem ? { ok: false, message: problem } : { ok: true };
    return { pkg, dir, trust, ...off };
  });
}
