/**
 * Persistent image uploads — project icons, and the pictures users pick for
 * their own profile.
 *
 * The project settings modal lets the user paste/drop an image to use as a
 * project icon. The image is downscaled to a thumbnail *client-side* (canvas)
 * before it reaches us — there's no native image lib (`sharp`/`jimp`) in the
 * orchestrator deps and pulling one in just to shrink a 256px favicon isn't
 * worth the native-build weight. So this module only validates + persists the
 * already-thumbnailed bytes, and serves them back with a path-traversal guard.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TIMON_HOME } from './paths.js';

const UPLOADS_PROJECTS_DIR = join(TIMON_HOME, 'uploads', 'projects');
/** Kept apart from the project icons: the two are served by different routes
 *  and only one of them is a personal datum. */
const UPLOADS_AVATARS_DIR = join(TIMON_HOME, 'uploads', 'avatars');

/** Allowed image mime → file extension. SVG is excluded on purpose: it can
 *  embed scripts and we serve these inline, so we keep it to raster formats. */
const MIME_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Max bytes accepted for the persisted thumbnail. The client downscales to
 *  ~256px so anything bigger means the payload wasn't actually shrunk; reject
 *  it rather than store a full-res image under a "thumbnail" pretense. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type UploadResult = { url: string };

/** Parse a `data:` URL or raw base64 into {mime, bytes}. Throws on anything
 *  that isn't a recognised image. */
function decodeImagePayload(input: { dataUrl?: unknown; mime?: unknown; data?: unknown }): {
  ext: string;
  bytes: Buffer;
} {
  let mime: string;
  let b64: string;

  if (typeof input.dataUrl === 'string') {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(input.dataUrl);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new Error('dataUrl must be a base64 data: URL');
    }
    mime = m[1].toLowerCase();
    b64 = m[2];
  } else if (typeof input.data === 'string' && typeof input.mime === 'string') {
    mime = input.mime.toLowerCase();
    b64 = input.data;
  } else {
    throw new Error('expected { dataUrl } or { mime, data }');
  }

  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported image type: ${mime}`);

  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw new Error('empty image payload');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`image too large (${bytes.length} bytes, max ${MAX_UPLOAD_BYTES})`);
  }
  return { ext, bytes };
}

/** The file signature must match the declared type: the mime comes from the
 *  caller (here possibly an agent), and the bytes are served back inline. */
function matchesImageSignature(ext: string, b: Buffer): boolean {
  switch (ext) {
    case 'png': return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg': return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'gif': return b.length > 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a');
    case 'webp': return b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
}

function saveImage(
  dir: string,
  urlPrefix: string,
  input: { dataUrl?: unknown; mime?: unknown; data?: unknown },
  opts: { verifySignature?: boolean } = {},
): UploadResult {
  const { ext, bytes } = decodeImagePayload(input);
  if (opts.verifySignature && !matchesImageSignature(ext, bytes)) {
    throw new Error(`payload is not a valid ${ext} image`);
  }
  mkdirSync(dir, { recursive: true });
  const file = `${randomUUID()}.${ext}`;
  writeFileSync(join(dir, file), bytes);
  return { url: `${urlPrefix}${file}` };
}

/** Persist a project-icon image and return the service URL the UI stores in
 *  the project's `icon` field. */
export function saveProjectIcon(input: { dataUrl?: unknown; mime?: unknown; data?: unknown }): UploadResult {
  return saveImage(UPLOADS_PROJECTS_DIR, '/api/uploads/projects/', input);
}

/** Same contract for a profile picture: the client downscales, we only
 *  validate and persist. The returned URL is what `PATCH /api/auth/profile`
 *  accepts — nothing else is. */
export function saveAvatar(input: { dataUrl?: unknown; mime?: unknown; data?: unknown }): UploadResult {
  return saveImage(UPLOADS_AVATARS_DIR, '/api/uploads/avatars/', input);
}

/** Pictures set on an agent by another agent or an operator (`PUT
 *  /api/agents/:name/avatar`). Own directory: a removed or replaced picture is
 *  deleted from here without ever touching the user-uploaded project logos. */
const UPLOADS_AGENTS_DIR = join(TIMON_HOME, 'uploads', 'agents');
export const AGENT_ICON_URL_PREFIX = '/api/uploads/agents/';

export function saveAgentIcon(input: { dataUrl?: unknown; mime?: unknown; data?: unknown }): UploadResult {
  return saveImage(UPLOADS_AGENTS_DIR, AGENT_ICON_URL_PREFIX, input, { verifySignature: true });
}

export function readAgentIcon(name: string): ServedFile {
  return readImage(UPLOADS_AGENTS_DIR, name);
}

/** Drops a picture an agent no longer refers to. Silent on a URL that is not
 *  one of ours: the caller derives it from a stored `icon_url`. */
export function deleteAgentIconByUrl(url: string | null | undefined): void {
  if (!url || !url.startsWith(AGENT_ICON_URL_PREFIX)) return;
  const name = url.slice(AGENT_ICON_URL_PREFIX.length);
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|gif)$/.test(name)) return;
  rmSync(join(UPLOADS_AGENTS_DIR, name), { force: true });
}

const SERVED_ICON_URL = /^\/api\/uploads\/(?:projects|avatars|agents)\/[A-Za-z0-9-]+\.(?:png|jpg|webp|gif)$/;

/** An agent's `icon_url` is a picture this daemon serves, nothing else. The
 *  window CSP (`img-src 'self' data: blob:`) blocks any other origin — an image
 *  request is also a way out for data — so an external address would be
 *  stored only to never show. */
export function isServedIconUrl(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 500 && SERVED_ICON_URL.test(url);
}

/** What the API exposes of a stored `icon_url`: an address set before the rule
 *  above (an http(s) URL) reads as no picture, so the UI shows the fallback and
 *  an editor round-trip does not send it back to be refused. */
export function servedIconUrl(url: string | null | undefined): string | null {
  return isServedIconUrl(url) ? url : null;
}

/** Pictures a superadmin picks for a backend they added, or for one of its
 *  models. Kept apart from the project icons: they answer to another route,
 *  and removing a backend takes its pictures with it. */
const UPLOADS_BACKENDS_DIR = join(TIMON_HOME, 'uploads', 'backends');

export function saveBackendIcon(input: { dataUrl?: unknown; mime?: unknown; data?: unknown }): UploadResult {
  return saveImage(UPLOADS_BACKENDS_DIR, '/api/uploads/backends/', input);
}

const EXT_CONTENT_TYPE: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export type ServedFile = { bytes: Buffer; contentType: string };

function readImage(dir: string, name: string): ServedFile {
  const ext = extname(name).toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext];
  if (!contentType) throw new Error('unsupported file');

  const full = resolve(dir, name);
  const root = resolve(dir);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('path traversal rejected');
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new Error('not found');
  }
  return { bytes: readFileSync(full), contentType };
}

/** Read a previously-uploaded project icon for serving. Rejects any name that
 *  escapes the uploads dir (path traversal) and unknown extensions. */
export function readProjectIcon(name: string): ServedFile {
  return readImage(UPLOADS_PROJECTS_DIR, name);
}

export function readAvatar(name: string): ServedFile {
  return readImage(UPLOADS_AVATARS_DIR, name);
}

export function readBackendIcon(name: string): ServedFile {
  return readImage(UPLOADS_BACKENDS_DIR, name);
}

/** Drops a picture a backend no longer refers to. Silent on a name that is
 *  not one of ours: the caller derives it from a stored URL, and a file that
 *  is already gone is the outcome asked for. */
export function deleteBackendIcon(name: string): void {
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|gif)$/.test(name)) return;
  rmSync(join(UPLOADS_BACKENDS_DIR, name), { force: true });
}

/** Personal backdrops live in owner-isolated directories. URLs deliberately
 * omit the owner: every read resolves it from the authenticated session. */
function backgroundDir(owner: string): string {
  if (!owner) throw new Error('owner required');
  return join(TIMON_HOME, 'uploads', 'backgrounds', createHash('sha256').update(owner).digest('hex'));
}
export function saveBackgroundImage(owner: string, input: { dataUrl?: unknown }): UploadResult {
  const dir = backgroundDir(owner);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return saveImage(dir, '/api/ui/appearance/background-image/', input);
}
export function readBackgroundImage(owner: string, name: string): ServedFile {
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|gif)$/.test(name)) throw new Error('invalid file');
  return readImage(backgroundDir(owner), name);
}
export function deleteBackgroundImage(owner: string, name: string): void {
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|gif)$/.test(name)) throw new Error('invalid file');
  rmSync(join(backgroundDir(owner), name), { force: true });
}
