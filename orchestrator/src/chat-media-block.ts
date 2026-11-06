/**
 * The typed request an agent makes to show a media in its chat, and the typed
 * block the chat receives (SUG-0008).
 *
 * `src` is hostile by default. It is classified here, once, into one of three
 * sources — an absolute path under the mission's roots, an `https://` address
 * fetched by the daemon, a raster `data:` image — and everything else is
 * refused with a named reason the agent can act on. Whatever the source, the
 * bytes are checked and kept on the daemon: the block names a file of ours,
 * never the address it came from (it may carry a token).
 */

import { closeSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  MediaError, generatedMediaDir, mediaStream, openMissionMedia, reserveMissionMedia, sniffMedia,
  type MediaKind, type OpenedMedia, type SniffedMedia,
} from './chat-media.js';
import { MediaFetchError, fetchRemoteMedia, type FetchDeps } from './chat-media-fetch.js';

/** A `data:` image is inline: kept to what a pasted screenshot needs. */
export const MAX_DATA_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CAPTION_CHARS = 300;
/** Room for the largest `data:` image, base64 included. */
const MAX_SRC_CHARS = 14 * 1024 * 1024;

export const MediaRequestSchema = z.object({
  src: z.string().min(1).max(MAX_SRC_CHARS),
  caption: z.string().max(MAX_CAPTION_CHARS).optional(),
}).strict();

export type MediaRequest = z.infer<typeof MediaRequestSchema>;

export type MediaSource = 'file' | 'url' | 'data';

/** What the chat renders. Plain values only: the caption is text, `host` is
 *  shown as provenance, and `file` is a name this daemon minted. */
export type MediaBlock = {
  type: 'media';
  file: string;
  kind: MediaKind;
  mime: string;
  source: MediaSource;
  caption?: string;
  host?: string;
};

/** Schemes refused by name, so the agent reads why rather than guessing. */
const REFUSED_SCHEMES = /^(?:javascript|vbscript|blob|file|http|ftp|ws|wss|about|chrome|filesystem):/i;
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

function tooLarge(): MediaError {
  return new MediaError(413, 'the media is larger than the allowed size', 'too_large');
}

async function storeOpened(missionId: string, opened: OpenedMedia, limit: number | undefined): Promise<string> {
  let release: () => void;
  try {
    release = reserveMissionMedia(missionId, opened.size, limit);
  } catch (err) {
    closeSync(opened.fd); // no stream will ever own it
    throw err;
  }
  try {
    const dir = generatedMediaDir(missionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `${randomUUID()}.${opened.media.ext}`;
    // Streamed from the descriptor that was checked: whatever the path points
    // to by now, these are the bytes kept.
    await pipeline(mediaStream(opened, null), createWriteStream(join(dir, file), { mode: 0o600 }));
    return file;
  } finally {
    release();
  }
}

function storeBytes(missionId: string, bytes: Buffer, media: SniffedMedia, limit: number | undefined): string {
  const release = reserveMissionMedia(missionId, bytes.length, limit);
  try {
    const dir = generatedMediaDir(missionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `${randomUUID()}.${media.ext}`;
    writeFileSync(join(dir, file), bytes, { mode: 0o600 });
    return file;
  } finally {
    release();
  }
}

function block(file: string, media: SniffedMedia, source: MediaSource, caption: string | undefined, host?: string): MediaBlock {
  const text = caption?.trim();
  return {
    type: 'media',
    file,
    kind: media.kind,
    mime: media.mime,
    source,
    ...(text ? { caption: text } : {}),
    ...(host ? { host } : {}),
  };
}

export type AddMediaContext = {
  /** Directories a local path may resolve into. */
  roots: readonly string[];
  fetch?: FetchDeps;
  /** The mission's media ceiling, all calls together; `MAX_MISSION_MEDIA_BYTES` by default. */
  missionLimitBytes?: number;
};

/**
 * Checks, fetches or copies, keeps, and describes one media. Throws
 * `MediaError` or `MediaFetchError`; both carry a code and a message safe to
 * hand back to the agent (neither repeats the address).
 */
export async function addMissionMedia(missionId: string, request: MediaRequest, ctx: AddMediaContext): Promise<MediaBlock> {
  const src = request.src.trim();

  if (/^data:/i.test(src)) {
    const m = DATA_IMAGE.exec(src);
    if (!m) throw new MediaError(400, 'a data: URL must hold a PNG, JPEG, GIF or WebP image in base64', 'data_refused');
    const bytes = Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64');
    if (bytes.length === 0) throw new MediaError(400, 'empty image', 'not_media');
    if (bytes.length > MAX_DATA_IMAGE_BYTES) throw tooLarge();
    const media = sniffMedia(bytes.subarray(0, 32));
    if (!media || media.kind !== 'image' || media.mime !== m[1]!.toLowerCase()) {
      throw new MediaError(415, 'the bytes are not the image that was announced', 'not_media');
    }
    return block(storeBytes(missionId, bytes, media, ctx.missionLimitBytes), media, 'data', request.caption);
  }

  if (/^https:/i.test(src)) {
    // Checked before the download too: a mission at its ceiling does not make the daemon fetch 100 MB for nothing.
    reserveMissionMedia(missionId, 0, ctx.missionLimitBytes)();
    const fetched = await fetchRemoteMedia(src, ctx.fetch);
    return block(storeBytes(missionId, fetched.bytes, fetched.media, ctx.missionLimitBytes), fetched.media, 'url', request.caption, fetched.host);
  }

  if (REFUSED_SCHEMES.test(src)) {
    throw new MediaError(400, 'only https:// addresses, raster data: images and absolute paths are accepted', 'scheme_refused');
  }

  const opened = openMissionMedia(src, ctx.roots);
  try {
    const file = await storeOpened(missionId, opened, ctx.missionLimitBytes);
    return block(file, opened.media, 'file', request.caption);
  } catch (err) {
    throw err instanceof MediaError ? err : new MediaError(400, 'the file could not be kept', 'fetch_failed');
  }
}

export function mediaErrorResponse(err: unknown): { status: number; body: { error: string; message: string } } | null {
  if (err instanceof MediaError) return { status: err.status, body: { error: err.code, message: err.message } };
  if (err instanceof MediaFetchError) {
    const status = err.code === 'too_large' ? 413 : err.code === 'fetch_failed' ? 502 : 400;
    return { status, body: { error: err.code, message: err.message } };
  }
  return null;
}
