/**
 * Streams a checked, already-opened file over HTTP. Shared by the chat media
 * and the Files widget's viewer: same range handling, same descriptor
 * discipline.
 */
import { closeSync } from 'node:fs';
import type { Request, Response } from 'express';
import { MediaError, mediaHeaders, mediaStream, parseRange, type OpenedMedia, type SniffedMedia } from './chat-media.js';

/** A checked file ready to leave: a chat image or video (headers derived from
 *  its sniffed type), or anything else that brings its own headers — a PDF, an
 *  Office document. */
export type OpenedFile = Pick<OpenedMedia, 'fd' | 'size' | 'name'>
  & ({ media: SniffedMedia } | { headers: (download: boolean) => Record<string, string> });

/** Streams a checked media file, honouring a single byte range so a video
 *  can seek. The descriptor is closed on every path that does not stream. */
export function sendMedia(req: Request, res: Response, open: () => OpenedFile, immutable: boolean): void {
  let opened: OpenedFile;
  try {
    opened = open();
  } catch (err) {
    if (err instanceof MediaError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
  const download = req.query.download === '1';
  const headers = 'headers' in opened ? opened.headers(download) : mediaHeaders(opened.media, opened.name, download);
  headers['cache-control'] = immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache';
  const range = parseRange(req.header('range'), opened.size);
  if (range === 'unsatisfiable') {
    closeSync(opened.fd);
    res.status(416).set({ ...headers, 'content-range': `bytes */${opened.size}` }).end();
    return;
  }
  if (range) {
    res.status(206).set({
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${opened.size}`,
      'content-length': String(range.end - range.start + 1),
    });
  } else {
    res.status(200).set({ ...headers, 'content-length': String(opened.size) });
  }
  if (req.method === 'HEAD') {
    closeSync(opened.fd);
    res.end();
    return;
  }
  const stream = mediaStream(opened, range);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
