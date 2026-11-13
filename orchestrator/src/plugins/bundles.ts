import { fixedComposition } from '../license/capabilities.js';
import { licenseState } from '../license/runtime.js';
/**
 * Server of the browser halves — `GET /plugins/<id>/client.js?rev=<hash>`
 * (§10.8 of the plan).
 *
 * A third-party plugin publishes two halves: the one that runs in the daemon
 * (mounted by the loader) and the one that runs in the browser. The second
 * is only an ESM file; it simply has to be served, and served in a way
 * that lets the browser cache it without ever running a stale
 * version. Hence `rev`:
 *
 *  - `rev` = SHA-256 of the file, computed at registration. It changes as soon
 *    as the file changes, so the URL changes, so the cache is invalidated
 *    without having to ask the browser anything;
 *  - `rev` matching the current revision → `immutable` response, one year of
 *    cache. It is what makes a page reload free;
 *  - unknown `rev` → 404. Serving the current file under an old
 *    revision would put into the browser's "immutable" cache a
 *    content labelled with the wrong key — the stale version would then
 *    stay stuck for a year;
 *  - missing `rev` → the current file, `no-cache`. It is the call made
 *    by hand to look at what the daemon serves; the UI, for its part, reads the `rev`
 *    in `/api/plugins` and always passes it.
 *
 * ## What this module refuses to do
 *
 * **It never builds a path from the URL.** The id is looked up in the
 * registry, and the registry only knows paths resolved at
 * registration from the package's `package.json`. A URL can therefore
 * only name a file the manifest declared — never a neighbouring
 * file, never a file of the daemon. Two independent checks hold this:
 * the shape of the id (that of the manifest, which admits neither `.` nor `/`), and the
 * confinement of the declared path within the package folder.
 *
 * No multi-file combo, no source maps: §10.8 rules them out
 * explicitly for v1 (dsh needs them for a graph of 40 packages; we
 * will serve a handful).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { Request, Response, Router } from 'express';
import express from 'express';
import { viewerFromRequest } from '../users/identity.js';
import { thirdPartyAssetVisible } from '../users/surfaces.js';
import { apiError } from '../api-error.js';

/** Public prefix of the bundles. Outside `/api`: it is an asset, not an API. */
export const BUNDLE_ROUTE_PREFIX = '/plugins';

/** Same shape as `rooks.id` (manifest.ts) — an id is never a path. */
const ID_RE = /^[a-z0-9-]{3,40}$/;

/**
 * Resolves the `kind` list of an installed plugin, so the visibility curtain
 * can tell a layout from the rest (`users/surfaces.ts`). Supplied by the route
 * that owns the loader; the registry itself only ever knows resolved paths.
 * An unknown id yields an empty list — strict `plugin:<id>`, never a grant.
 */
export type PluginKindsOf = (req: Request, id: string) => readonly string[];

export type Bundle = {
  id: string;
  /** Absolute path of the served file, resolved at registration. */
  file: string;
  /** SHA-256 of the content, in hexadecimal. */
  rev: string;
  /**
   * SHA-256 of the content with its CRLF line endings read as LF: the identity
   * of the code, where `rev` is the identity of the bytes. A file committed to
   * git comes out with CRLF on a Windows checkout and LF elsewhere, so the same
   * release built on two OS serves two `rev` for one code. On a remote machine
   * the UI compares a built-in's `digest` with its local copy's (TIM-0135,
   * `app/src/lib/plugin-host/remote-plugins.ts`).
   */
  digest: string;
  /** URL the UI loads (`import()`), revision included. */
  url: string;
  /** Plugin built into the product: served even under a frozen composition. */
  builtin?: true;
};

/**
 * Resolves the browser half of a package from its `package.json`.
 *
 * `exports['./client']` and nothing else (§10.3): neither `main`, nor a guessed
 * convention like `lib/client.js`. A plugin declares what it publishes, otherwise
 * the first file in the right place would become servable by accident.
 */
export function resolveClientEntry(
  dir: string,
  packageJson: unknown,
): { ok: true; file: string } | { ok: false; message: string } {
  const exportsField = (packageJson as { exports?: unknown } | null)?.exports;
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
    return { ok: false, message: 'the manifest declares `client` but package.json has no `exports` field' };
  }
  const entry = (exportsField as Record<string, unknown>)['./client'];
  const rel = typeof entry === 'string' ? entry : pickCondition(entry);
  if (rel === null) {
    return { ok: false, message: 'the manifest declares `client` but `exports["./client"]` is missing or unreadable' };
  }
  if (isAbsolute(rel) || rel.length === 0) {
    return { ok: false, message: `\`exports["./client"]\` must be a path relative to the package (got: ${rel})` };
  }
  const file = resolve(dir, rel);
  // Confinement: a `../..` in `exports` would leave the package. Textual
  // comparison and not `realpath` — the fixture packages are symbolic
  // links, and it is the DECLARED path we want to constrain.
  const root = resolve(dir);
  if (file !== root && !file.startsWith(root + sep)) {
    return { ok: false, message: `\`exports["./client"]\` escapes the package (${rel})` };
  }
  return { ok: true, file };
}

/** See `Bundle.digest`. Only `\r\n` is folded: a lone `\r` is content. */
export function codeDigest(content: Buffer): string {
  return createHash('sha256').update(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');
}

/** ESM conditions, in the order Node would look at them for an `import`. */
function pickCondition(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const rec = entry as Record<string, unknown>;
  for (const key of ['browser', 'import', 'default']) {
    const v = rec[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * The servable bundles, at a given instant. One instance per daemon, kept
 * up to date by the loader: what is not mounted is not served, a disabled
 * plugin therefore disappears from the URL at the same time as from its routes.
 */
export class BundleRegistry {
  private readonly bundles = new Map<string, Bundle>();

  /**
   * Registers (or re-registers) the browser half of a plugin. Returns the
   * bundle, or the explanation of the refusal — never an exception: an unreadable
   * client must not prevent the host half from running.
   */
  register(id: string, dir: string, packageJson: unknown, builtin = false): { ok: true; bundle: Bundle } | { ok: false; message: string } {
    if (!ID_RE.test(id)) return { ok: false, message: `invalid plugin id: ${id}` };
    const resolved = resolveClientEntry(dir, packageJson);
    if (!resolved.ok) return resolved;
    let rev: string;
    let digest: string;
    try {
      const content = readFileSync(resolved.file);
      rev = createHash('sha256').update(content).digest('hex');
      digest = codeDigest(content);
    } catch (err) {
      return { ok: false, message: `unreadable browser half (${resolved.file}): ${(err as Error).message}` };
    }
    const bundle: Bundle = {
      id,
      file: resolved.file,
      rev,
      digest,
      url: `${BUNDLE_ROUTE_PREFIX}/${id}/client.js?rev=${rev}`,
      ...(builtin ? { builtin: true as const } : {}),
    };
    this.bundles.set(id, bundle);
    return { ok: true, bundle };
  }

  unregister(id: string): void {
    this.bundles.delete(id);
  }

  get(id: string): Bundle | null {
    return this.bundles.get(id) ?? null;
  }

  list(): Bundle[] {
    return [...this.bundles.values()].map((b) => ({ ...b }));
  }

  /** Keeps only the given ids — the counterpart of a loader reconciliation. */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of [...this.bundles.keys()]) {
      if (!keep.has(id)) this.bundles.delete(id);
    }
  }
}

/**
 * Serves an already resolved bundle. `registry` comes from the loader hooked onto the app,
 * never from a path derived from the URL.
 */
export function sendBundle(
  req: Request,
  res: Response,
  registry: BundleRegistry | null,
  getKinds: PluginKindsOf = () => [],
): void {
  const raw = req.params.id;
  const id = typeof raw === 'string' ? raw : '';
  // A built-in ships with the product: a fixed composition keeps serving it.
  if (fixedComposition(licenseState()) && !(ID_RE.test(id) && registry?.get(id)?.builtin)) {
    res.status(403).json({ error: 'plugin_composition_fixed' });
    return;
  }
  // The id is never concatenated to a path; this check is there so that the
  // answer is frank (named 404) rather than an ambiguous "bundle missing".
  if (!ID_RE.test(id) || !registry) {
    res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    return;
  }
  if (!thirdPartyAssetVisible(viewerFromRequest(req), id, getKinds(req, id))) {
    res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    return;
  }
  const bundle = registry.get(id);
  if (!bundle) {
    res.status(404).json({ error: `no browser half served for \`${id}\`` });
    return;
  }

  const rev = typeof req.query.rev === 'string' ? req.query.rev : null;
  if (rev !== null && rev !== bundle.rev) {
    // Stale revision: it is up to the client to read `/api/plugins` again — serving
    // it the current file would pollute its immutable cache.
    res.status(404).json({ error: 'unknown revision', rev: bundle.rev });
    return;
  }

  let body: Buffer;
  try {
    body = readFileSync(bundle.file);
  } catch (err) {
    res.status(404).json({ error: `unreadable browser half: ${(err as Error).message}` });
    return;
  }

  res.set('Content-Type', 'text/javascript; charset=utf-8');
  res.set('ETag', `"${bundle.rev}"`);
  // `immutable` only when the URL carries the revision: without it, the URL
  // is stable and its content is not.
  res.set('Cache-Control', rev === null ? 'no-cache' : 'public, max-age=31536000, immutable');
  if (req.headers['if-none-match'] === `"${bundle.rev}"`) {
    res.status(304).end();
    return;
  }
  // `res.send` omits the body on a HEAD while keeping the headers.
  res.send(body);
}

/**
 * The router that serves the bundles. Mounted at the root (`/plugins/...`), it
 * answers only one URL shape. `getRegistry` is read again on each request:
 * a disabled plugin disappears from the registry without the route being remounted.
 */
export function bundleRouter(
  getRegistry: (req: Request) => BundleRegistry | null,
  getKinds: PluginKindsOf = () => [],
): Router {
  const router = express.Router();
  router.get(`${BUNDLE_ROUTE_PREFIX}/:id/client.js`, (req, res) => {
    sendBundle(req, res, getRegistry(req), getKinds);
  });
  return router;
}
