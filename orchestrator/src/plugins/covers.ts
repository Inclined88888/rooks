/**
 * Cover art server — `GET /plugins/<id>/cover?rev=<hash>` (plan §10.12).
 *
 * The local gallery lists the plugins PRESENT on the machine, plugged in and
 * unplugged alike. A cover must therefore survive what a bundle does not: a
 * plugin `disabled` in `timon.config.json`, or refused by the licence, has no
 * browser half and still has a card to draw. That is the whole reason this
 * registry exists next to `BundleRegistry` instead of inside it — the bundle
 * registry is fed on the MOUNT path (`refreshBundle`), this one on the
 * DISCOVERY path.
 *
 * Same discipline as `bundles.ts`, for the same reason: the file path is
 * resolved once, from the package directory the loader discovered, and never
 * derived from the URL. `CoverSchema` already forbids a leading `/` and any
 * `..`, but the regex is not what is relied upon — the containment check
 * below is.
 *
 * A cover is attacker-supplied bytes served same-origin, and `.svg` is an
 * allowed extension: an SVG opened directly in a tab executes its scripts.
 * Hence `nosniff` + a `default-src 'none'` CSP on every response — inert in an
 * `<img>`, inert in a tab.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import type { Request, Response, Router } from 'express';
import express from 'express';
import { viewerFromRequest } from '../users/identity.js';
import { thirdPartyAssetVisible } from '../users/surfaces.js';
import { apiError } from '../api-error.js';

/** Public prefix, shared with the bundles: a cover is an asset, not an API. */
export const COVER_ROUTE_PREFIX = '/plugins';

/** Same shape as `timon.id` (manifest.ts) — an id is never a path. */
const ID_RE = /^[a-z0-9-]{3,40}$/;

/** Same resolver as the bundles: `kind` of an installed id, or nothing. */
export type PluginKindsOf = (req: Request, id: string) => readonly string[];

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
});

export type Cover = {
  id: string;
  /** Absolute path, resolved at registration. */
  file: string;
  contentType: string;
  /** SHA-256 of the contents, hexadecimal. */
  rev: string;
  /** URL the gallery renders, revision included. */
  url: string;
};

/** Resolves `timon.cover` against the package directory, or explains the refusal. */
export function resolveCoverFile(
  dir: string,
  cover: string,
): { ok: true; file: string; contentType: string } | { ok: false; message: string } {
  if (isAbsolute(cover) || cover.length === 0) {
    return { ok: false, message: `\`cover\` must be a path relative to the package (got: ${cover})` };
  }
  const file = resolve(dir, cover);
  const root = resolve(dir);
  if (file !== root && !file.startsWith(root + sep)) {
    return { ok: false, message: `\`cover\` escapes the package (${cover})` };
  }
  const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
  if (contentType === undefined) {
    return { ok: false, message: `unsupported \`cover\` extension (${cover})` };
  }
  return { ok: true, file, contentType };
}

/** The covers servable at a given instant. One instance per daemon. */
export class CoverRegistry {
  private readonly covers = new Map<string, Cover>();
  private readonly stills = new Map<string, Cover[]>();
  private readonly icons = new Map<string, Cover>();

  register(id: string, dir: string, cover: string): { ok: true; cover: Cover } | { ok: false; message: string } {
    if (!ID_RE.test(id)) return { ok: false, message: `invalid plugin id: ${id}` };
    const built = buildCover(id, dir, cover, `${COVER_ROUTE_PREFIX}/${id}/cover`);
    if (!built.ok) return built;
    this.covers.set(id, built.cover);
    return { ok: true, cover: built.cover };
  }

  /** The gallery picto (`timon.icon`). Same rules as a cover, SVG only (the schema says so). */
  registerIcon(id: string, dir: string, icon: string): { ok: true; cover: Cover } | { ok: false; message: string } {
    if (!ID_RE.test(id)) return { ok: false, message: `invalid plugin id: ${id}` };
    if (extname(icon).toLowerCase() !== '.svg') return { ok: false, message: `\`icon\` must be an SVG (${icon})` };
    const built = buildCover(id, dir, icon, `${COVER_ROUTE_PREFIX}/${id}/icon`);
    if (!built.ok) return built;
    this.icons.set(id, built.cover);
    return { ok: true, cover: built.cover };
  }

  unregisterIcon(id: string): void {
    this.icons.delete(id);
  }

  getIcon(id: string): Cover | null {
    return this.icons.get(id) ?? null;
  }

  registerStills(id: string, dir: string, shots: readonly string[]): void {
    if (!ID_RE.test(id)) {
      this.stills.delete(id);
      return;
    }
    const entries: Cover[] = [];
    for (const [index, shot] of shots.entries()) {
      const built = buildCover(id, dir, shot, `${COVER_ROUTE_PREFIX}/${id}/still/${index}`);
      if (!built.ok) {
        console.warn(`[plugins] ${id}: still ${index}: ${built.message}`);
        continue;
      }
      entries.push(built.cover);
    }
    if (entries.length) this.stills.set(id, entries);
    else this.stills.delete(id);
  }

  unregister(id: string): void {
    this.covers.delete(id);
  }

  get(id: string): Cover | null {
    return this.covers.get(id) ?? null;
  }

  getStill(id: string, index: number): Cover | null {
    return this.stills.get(id)?.[index] ?? null;
  }

  listStills(id: string): Cover[] {
    return [...(this.stills.get(id) ?? [])];
  }

  /** Keeps only the given ids — the counterpart of a loader reconcile. */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of [...this.covers.keys()]) {
      if (!keep.has(id)) this.covers.delete(id);
    }
    for (const id of [...this.stills.keys()]) {
      if (!keep.has(id)) this.stills.delete(id);
    }
    for (const id of [...this.icons.keys()]) {
      if (!keep.has(id)) this.icons.delete(id);
    }
  }
}

function buildCover(
  id: string,
  dir: string,
  cover: string,
  urlPath: string,
): { ok: true; cover: Cover } | { ok: false; message: string } {
  const resolved = resolveCoverFile(dir, cover);
  if (!resolved.ok) return resolved;
  let rev: string;
  try {
    rev = createHash('sha256').update(readFileSync(resolved.file)).digest('hex');
  } catch (err) {
    return { ok: false, message: `unreadable cover (${resolved.file}): ${(err as Error).message}` };
  }
  return {
    ok: true,
    cover: {
      id,
      file: resolved.file,
      contentType: resolved.contentType,
      rev,
      url: `${urlPath}?rev=${rev}`,
    },
  };
}

export function sendCover(
  req: Request,
  res: Response,
  registry: CoverRegistry | null,
  getKinds: PluginKindsOf = () => [],
  pick: (registry: CoverRegistry, id: string) => Cover | null = (r, id) => r.get(id),
): void {
  const raw = req.params.id;
  const id = typeof raw === 'string' ? raw : '';
  if (!ID_RE.test(id) || !registry) {
    res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    return;
  }
  if (!thirdPartyAssetVisible(viewerFromRequest(req), id, getKinds(req, id))) {
    res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    return;
  }
  const cover = pick(registry, id);
  if (!cover) {
    res.status(404).json({ error: `no cover served for \`${id}\`` });
    return;
  }
  const rev = typeof req.query.rev === 'string' ? req.query.rev : null;
  if (rev !== null && rev !== cover.rev) {
    res.status(404).json({ error: 'unknown revision', rev: cover.rev });
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(cover.file);
  } catch (err) {
    res.status(404).json({ error: `unreadable cover: ${(err as Error).message}` });
    return;
  }
  res.set('Content-Type', cover.contentType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.set('ETag', `"${cover.rev}"`);
  res.set('Cache-Control', rev === null ? 'no-cache' : 'public, max-age=31536000, immutable');
  if (req.headers['if-none-match'] === `"${cover.rev}"`) {
    res.status(304).end();
    return;
  }
  res.send(body);
}

/** Mounted at the root (`/plugins/<id>/cover`), registry re-read per request. */
export function sendStill(
  req: Request,
  res: Response,
  registry: CoverRegistry | null,
  getKinds: PluginKindsOf = () => [],
): void {
  const raw = req.params.id;
  const id = typeof raw === 'string' ? raw : '';
  const index = Number(req.params.n);
  if (!ID_RE.test(id) || !registry || !Number.isInteger(index) || index < 0) {
    res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    return;
  }
  if (!thirdPartyAssetVisible(viewerFromRequest(req), id, getKinds(req, id))) {
    res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
    return;
  }
  const still = registry.getStill(id, index);
  if (!still) {
    res.status(404).json({ error: `no still ${index} for \`${id}\`` });
    return;
  }
  const rev = typeof req.query.rev === 'string' ? req.query.rev : null;
  if (rev !== null && rev !== still.rev) {
    res.status(404).json({ error: 'unknown revision', rev: still.rev });
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(still.file);
  } catch (err) {
    res.status(404).json({ error: `unreadable still: ${(err as Error).message}` });
    return;
  }
  res.set('Content-Type', still.contentType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.set('ETag', `"${still.rev}"`);
  res.set('Cache-Control', rev === null ? 'no-cache' : 'public, max-age=31536000, immutable');
  if (req.headers['if-none-match'] === `"${still.rev}"`) {
    res.status(304).end();
    return;
  }
  res.send(body);
}

export function coverRouter(
  getRegistry: (req: Request) => CoverRegistry | null,
  getKinds: PluginKindsOf = () => [],
): Router {
  const router = express.Router();
  router.get(`${COVER_ROUTE_PREFIX}/:id/cover`, (req, res) => {
    sendCover(req, res, getRegistry(req), getKinds);
  });
  router.get(`${COVER_ROUTE_PREFIX}/:id/icon`, (req, res) => {
    sendCover(req, res, getRegistry(req), getKinds, (registry, id) => registry.getIcon(id));
  });
  router.get(`${COVER_ROUTE_PREFIX}/:id/still/:n`, (req, res) => {
    sendStill(req, res, getRegistry(req), getKinds);
  });
  return router;
}
