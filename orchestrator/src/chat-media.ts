/**
 * Images and videos an agent shows in the chat (SUG-0008).
 *
 * Whatever the source, the browser only ever loads a copy kept here and served
 * from the Rooks origin (`uploads/chat/<mission>/media/<uuid>.<ext>`, purged
 * with the mission's chat attachments):
 *  - a file the agent names by absolute path, read only under the mission's
 *    roots (its working directory, codex's `generated_images`);
 *  - an `https://` address, fetched by the daemon behind an SSRF guard
 *    (`chat-media-fetch.ts`) — never by the browser;
 *  - a `data:` URL, raster images only;
 *  - an image codex's built-in `image_gen` tool wrote during a turn. `codex
 *    exec --json` emits no item for it — the file just lands under
 *    `$CODEX_HOME/generated_images/` — so the turn's `result` collects it.
 *
 * The agent asks through a typed request (`MediaRequestSchema`, MCP tool
 * `chat_show_media`); the chat renders a typed block, never markdown or HTML.
 * What a kept byte can be is decided by its magic bytes, never by a name, an
 * extension or a header: raster images and a few video containers. SVG and
 * HTML are refused — served same-origin, either one would run script.
 */

import {
  closeSync, copyFileSync, createReadStream, fstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync,
  type Dirent, type ReadStream,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chatAttachmentsRoot, safeAttachmentName } from './chat-attachments.js';
import { bus } from './bus.js';

export type MediaKind = 'image' | 'video';
export type SniffedMedia = { mime: string; ext: string; kind: MediaKind };

/** A local file the agent shows is copied: its size bounds a video, not a
 *  thumbnail, but it still has to fit next to the mission's attachments. */
export const MAX_LOCAL_MEDIA_BYTES = 200 * 1024 * 1024;
/** Per generated image, and how many one turn may bring back. */
export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_GENERATED_PER_TURN = 12;
/** Everything one mission may keep, all sources together. Each call is capped
 *  on its own, but an agent calling in a loop filled the disk 100 MB at a time
 *  until its mission ended and the purge came (TODO #547). */
export const MAX_MISSION_MEDIA_BYTES = 1024 * 1024 * 1024;
const MAX_PATH_CHARS = 4096;
const SNIFF_BYTES = 32;

export class MediaError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 415, message: string, readonly code = 'refused') {
    super(message);
  }
}

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('latin1');
}

/** The container the first bytes announce, or null for anything we will not
 *  put in front of a browser. */
export function sniffMedia(head: Buffer): SniffedMedia | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  }
  if (head.length >= 6 && (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a')) {
    return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  }
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  }
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif', kind: 'image' };
    // HEIC and friends: no browser outside Safari decodes them.
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return null;
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  }
  if (head.length >= 4 && ascii(head, 0, 4) === 'OggS') {
    return { mime: 'video/ogg', ext: 'ogv', kind: 'video' };
  }
  return null;
}

function readHead(fd: number): Buffer {
  const head = Buffer.alloc(SNIFF_BYTES);
  const n = readSync(fd, head, 0, SNIFF_BYTES, 0);
  return head.subarray(0, n);
}

/**
 * Turns what the agent wrote into an absolute path, or refuses. A `file:` URL
 * is refused like any scheme: a local file is named by its path. UNC paths are
 * refused outright: on Windows, merely opening one makes the machine
 * authenticate to that host.
 */
export function parseMediaPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PATH_CHARS || raw.includes('\0')) {
    throw new MediaError(400, 'invalid path', 'path_refused');
  }
  if (/^[\\/]{2}/.test(raw)) throw new MediaError(400, 'network paths are refused', 'path_refused');
  if (/^[a-z][a-z0-9+.-]+:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
    throw new MediaError(400, 'this scheme is refused', 'scheme_refused');
  }
  if (!isAbsolute(raw) && !win32.isAbsolute(raw)) throw new MediaError(400, 'an absolute path is required', 'path_refused');
  return resolve(raw);
}

export function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** True when `target` sits under `root` and no step below the root is hidden
 *  (`.git`, `.ssh`, `.env.d`…): an agent's picture never lives there. */
export function underRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  return !rel.split(sep).some((segment) => segment.startsWith('.'));
}

export type OpenedMedia = {
  fd: number;
  size: number;
  media: SniffedMedia;
  /** Display name for a download, never a path. */
  name: string;
};

function openChecked(real: string, maxBytes: number): OpenedMedia {
  let fd: number;
  try {
    fd = openSync(real, 'r');
  } catch {
    throw new MediaError(404, 'not found');
  }
  try {
    // Checked on the descriptor we are about to stream from: whatever the
    // path points to by now, these are the bytes that leave.
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0) throw new MediaError(404, 'not found');
    if (st.size > maxBytes) throw new MediaError(415, 'file too large');
    const media = sniffMedia(readHead(fd));
    if (!media) throw new MediaError(415, 'not an image or video');
    return { fd, size: st.size, media, name: safeAttachmentName(real.split(/[\\/]/).pop()) };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Opens a file the agent named, provided it resolves — symlinks followed —
 *  under one of `roots`. Missing roots are ignored. */
export function openMissionMedia(raw: unknown, roots: readonly string[]): OpenedMedia {
  const path = parseMediaPath(raw);
  const real = realOrNull(path);
  if (!real) throw new MediaError(404, 'not found');
  const realRoots = roots.map(realOrNull).filter((r): r is string => r !== null);
  if (!realRoots.some((root) => underRoot(root, real))) throw new MediaError(404, 'not found');
  return openChecked(real, MAX_LOCAL_MEDIA_BYTES);
}

/** Where a mission's collected images live: inside its chat attachments, so
 *  `purgeChatAttachments` takes them with the rest. */
export function generatedMediaDir(missionId: string): string {
  return join(chatAttachmentsRoot(), safeAttachmentName(missionId), 'media');
}

const STORED_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|gif|webp|avif|mp4|mov|webm|ogv)$/;

/** A kept media file, by the name this module minted. */
export function openGeneratedMedia(missionId: string, file: unknown): OpenedMedia {
  if (typeof file !== 'string' || !STORED_FILE.test(file)) throw new MediaError(400, 'invalid file');
  return openChecked(join(generatedMediaDir(missionId), file), MAX_LOCAL_MEDIA_BYTES);
}

/** Bytes the mission's media folder holds now. */
export function missionMediaBytes(missionId: string): number {
  const dir = generatedMediaDir(missionId);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try { total += statSync(join(dir, entry.name)).size; } catch { /* removed meanwhile */ }
  }
  return total;
}

/** Writes in flight, per mission: two calls at once must not both fit under the ceiling. */
const reserved = new Map<string, number>();

/**
 * Claims `bytes` of the mission's media ceiling until the returned release is
 * called, once the file is written (or was not). Refuses with 413 past the
 * ceiling; `limit` 0 means none.
 */
export function reserveMissionMedia(missionId: string, bytes: number, limit = MAX_MISSION_MEDIA_BYTES): () => void {
  const pending = reserved.get(missionId) ?? 0;
  if (limit > 0 && missionMediaBytes(missionId) + pending + bytes > limit) {
    throw new MediaError(413, 'this conversation has reached its media storage limit', 'quota_exceeded');
  }
  reserved.set(missionId, pending + bytes);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (reserved.get(missionId) ?? 0) - bytes;
    if (left > 0) reserved.set(missionId, left);
    else reserved.delete(missionId);
  };
}

export type GeneratedMedia = { file: string; kind: MediaKind; mime: string; name: string };

/** Sources already copied, per mission: a second `result` for the same turn
 *  must not show the same picture twice. */
const collected = new Map<string, Set<string>>();

function walkFiles(dir: string, depth: number, out: string[]): void {
  if (depth > 4 || out.length >= 500) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= 500) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, depth + 1, out);
    else if (entry.isFile()) out.push(full);
  }
}

/**
 * Copies the images `sourceDir` gained since `sinceMs` into the mission's
 * media directory and describes them. Best effort: an unreadable file is
 * skipped, never a failed turn.
 */
export function collectGeneratedImages(missionId: string, sourceDir: string, sinceMs: number, limit = MAX_MISSION_MEDIA_BYTES): GeneratedMedia[] {
  const files: string[] = [];
  walkFiles(sourceDir, 0, files);
  const seen = collected.get(missionId) ?? new Set<string>();
  const fresh = files
    .map((path) => {
      try {
        const st = statSync(path);
        return { path, mtime: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    // One second of slack: some filesystems round mtimes down.
    .filter((f): f is { path: string; mtime: number; size: number } => !!f && f.mtime >= sinceMs - 1000 && !seen.has(f.path))
    .sort((a, b) => a.mtime - b.mtime);
  const out: GeneratedMedia[] = [];
  for (const f of fresh) {
    if (out.length >= MAX_GENERATED_PER_TURN) break;
    if (f.size === 0 || f.size > MAX_GENERATED_IMAGE_BYTES) continue;
    let opened: OpenedMedia;
    try {
      opened = openChecked(f.path, MAX_GENERATED_IMAGE_BYTES);
    } catch {
      continue;
    }
    closeSync(opened.fd);
    if (opened.media.kind !== 'image') continue;
    let release: () => void;
    try {
      release = reserveMissionMedia(missionId, opened.size, limit);
    } catch {
      console.warn('[chat-media] media storage limit reached: generated images of this turn not kept');
      break;
    }
    const file = `${randomUUID()}.${opened.media.ext}`;
    try {
      const dir = generatedMediaDir(missionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      copyFileSync(f.path, join(dir, file));
    } catch (err) {
      console.warn(`[chat-media] could not keep a generated image: ${(err as Error).message}`);
      continue;
    } finally {
      release();
    }
    seen.add(f.path);
    out.push({ file, kind: 'image', mime: opened.media.mime, name: opened.name });
  }
  collected.set(missionId, seen);
  return out;
}

/** A mission that ended no longer produces images: its dedup memory is dead
 *  weight, and the map has one entry per mission since the daemon started.
 *  Safe if the chat resumes: only files newer than the turn start are looked at. */
export function forgetMissionMedia(missionId: string): void {
  collected.delete(missionId);
}
bus.on('event', (ev) => { if (ev.kind === 'mission_complete') forgetMissionMedia(ev.missionId); });

/** Test-only. */
export function collectedMediaMissionCount(): number {
  return collected.size;
}

/** Test-only. */
export function resetCollectedMedia(): void {
  collected.clear();
  reserved.clear();
}

export type MediaRange = { start: number; end: number };

/** A single `bytes=` range, or null for the whole file. Multi-range requests
 *  get the whole file: no player needs them. */
export function parseRange(header: unknown, size: number): MediaRange | 'unsatisfiable' | null {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

/** Headers every media response carries. `sandbox`: opened in a tab of its
 *  own, the response is a document without script, whatever a browser makes
 *  of it. */
export function mediaHeaders(media: SniffedMedia, name: string, download: boolean): Record<string, string> {
  const fileName = `${name.replace(/\.[^.]*$/, '') || 'media'}.${media.ext}`;
  const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return {
    'content-type': media.mime,
    'x-content-type-options': 'nosniff',
    // The value raw.githubusercontent.com serves media with: displays an image
    // or plays a video opened on its own, runs nothing.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'accept-ranges': 'bytes',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  };
}

export function mediaStream(opened: Pick<OpenedMedia, 'fd'>, range: MediaRange | null): ReadStream {
  return createReadStream('', {
    fd: opened.fd,
    autoClose: true,
    ...(range ? { start: range.start, end: range.end } : { start: 0 }),
  });
}
