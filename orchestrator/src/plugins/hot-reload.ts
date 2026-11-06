/**
 * Hot reload of a plugin's WHOLE source tree, not just its entry file.
 *
 * Node's ESM cache is keyed by URL and cannot be purged. `import(entry?rev=…)`
 * gives the entry a fresh URL, but its relative imports (`./core.js`) resolve
 * against the entry's URL *with its query dropped*, so they keep coming from
 * the cache: a plugin split across files kept running its old `lib/*.js`
 * until the daemon restarted (TODO #359).
 *
 * The fix has two halves:
 *  - a resolve hook that carries the entry's `rev` onto every module resolved
 *    inside the plugin's own directory, so a remount really re-evaluates the
 *    tree;
 *  - a tree stamp (`treeStamp`) that makes the loader notice such an edit in
 *    the first place.
 *
 * The hook never touches a module outside the plugin directory (the daemon's
 * own modules stay singletons) nor anything under `node_modules`.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIPPED_DIRS = new Set(['node_modules', '.git']);
/** A plugin directory is small; this only bounds a pathological tree (a link
 *  to a home directory, a build cache) so the poll can never become expensive. */
const MAX_ENTRIES = 5_000;

/**
 * Fingerprint of every file of a plugin directory (path, size, mtime), minus
 * `node_modules` and `.git`. Directory mtimes are included, so an added or
 * deleted file changes it even when the survivors are untouched. Symlinks
 * inside the tree are stamped, never followed (no cycles).
 */
export function treeStamp(dir: string): string {
  const hash = createHash('sha1');
  let seen = 0;
  const walk = (current: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(current).sort();
    } catch {
      return; // vanished mid-walk: the next poll sees the final state
    }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) return;
      if (SKIPPED_DIRS.has(name)) continue;
      const abs = join(current, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      hash.update(`${rel}${name}|${st.size}|${st.mtimeMs}\n`);
      if (st.isDirectory()) walk(abs, `${rel}${name}/`);
    }
  };
  try {
    hash.update(`.|${statSync(dir).mtimeMs}\n`);
  } catch {
    return 'missing';
  }
  walk(dir, '');
  return hash.digest('hex').slice(0, 16);
}

/**
 * Resolve hook, evaluated off-thread by Node's module hooks. Inlined as a
 * `data:` URL: it must load without any TypeScript step, from `src/` under
 * tsx as well as from `dist/`.
 */
export const HOOK_SOURCE = `
// The drive letter of a Windows file URL is not stable: the resolved URL can
// say \`file:///c:/\` where the root, from realpath, says \`file:///C:/\`. A
// sub-module then left the revision and came from the cache, next to a fresh
// entry (TIM-0116). Only the drive letter is folded, never the rest of the path.
function drive(url) {
  return url.replace(/^file:\\/\\/\\/([A-Za-z]):/, (_m, d) => 'file:///' + d.toLowerCase() + ':');
}
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const parent = context.parentURL;
  if (!parent || parent.indexOf('?') === -1 || result.url.indexOf('file:') !== 0 || result.url.indexOf('?') !== -1) return result;
  let params;
  try { params = new URL(parent).searchParams; } catch { return result; }
  const root = params.get('root');
  const rev = params.get('rev');
  if (!root || !rev || drive(result.url).indexOf(drive(root)) !== 0) return result;
  if (result.format === 'commonjs' || /\\.cjs$/.test(result.url)) return result;
  if (result.url.slice(root.length).split('/').indexOf('node_modules') !== -1) return result;
  return { ...result, url: result.url + '?' + new URLSearchParams({ rev, root }).toString() };
}
`;

let hooksReady: boolean | null = null;

/** Registers the hook once. `false` on a Node without `module.register`: the
 *  entry still reloads, its sub-modules fall back to the cache as before. */
function ensureHooks(): boolean {
  if (hooksReady !== null) return hooksReady;
  try {
    register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`);
    hooksReady = true;
  } catch (err) {
    console.warn(`[plugins] sub-module hot reload unavailable: ${(err as Error).message}`);
    hooksReady = false;
  }
  return hooksReady;
}

/**
 * URL to import a plugin's host half from. With `dir`, every module the entry
 * pulls from inside that directory is re-evaluated under the same `rev`.
 * Without it (a built-in, whose files never change under the daemon), only the
 * entry is busted: its modules stay shared, exactly as before.
 */
export function entryUrl(entry: string, rev: string, dir: string | null): string {
  const base = pathToFileURL(entry).href;
  if (dir === null || !ensureHooks()) return `${base}?rev=${encodeURIComponent(rev)}`;
  let real = dir;
  try { real = realpathSync(dir); } catch { /* import will fail and report it */ }
  // Node resolves symlinks before the hook sees a URL: compare real paths.
  const root = pathToFileURL(real.endsWith(sep) ? real : real + sep).href;
  return `${base}?${new URLSearchParams({ rev, root }).toString()}`;
}

const requireCache = createRequire(import.meta.url).cache;

/**
 * CommonJS files (`.cjs`, or `.js` in a package without `"type": "module"`)
 * live in `require.cache`, outside the ESM hook's reach: evict the ones under
 * the plugin directory so the next import re-reads them.
 */
export function evictRequireCache(dir: string): void {
  let real = dir;
  try { real = realpathSync(dir); } catch { return; }
  const prefix = real.endsWith(sep) ? real : real + sep;
  for (const file of Object.keys(requireCache)) {
    if (file.startsWith(prefix) && !file.slice(prefix.length).split(sep).includes('node_modules')) {
      delete requireCache[file];
    }
  }
}
