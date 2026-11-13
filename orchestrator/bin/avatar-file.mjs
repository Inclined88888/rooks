/**
 * Reads a picture from disk for `agent_set_avatar` / `rooks agent set-avatar`.
 *
 * The daemon never opens a path on a caller's word: the file is read HERE, in
 * the caller's own process, and only inline bytes travel. This is the guard on
 * the way in — the picture must lie inside the folder the caller works from,
 * be a regular file of an allowed type, and stay under the daemon's cap. The
 * daemon checks the signature again.
 */
import fs from 'node:fs';
import { extname, relative, isAbsolute, resolve } from 'node:path';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** @returns {{ mime: string, data: string }} base64 payload for the daemon */
export function readAvatarFile(file, root = process.cwd()) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('file path required');
  const mime = EXT_MIME[extname(file).toLowerCase()];
  if (!mime) throw new Error('unsupported image type: use .png, .jpg, .jpeg, .webp or .gif');
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(resolve(root, file));
    realRoot = fs.realpathSync(root);
  } catch {
    throw new Error(`file not found: ${file}`);
  }
  // Compared after symlink resolution: a link inside the folder that points
  // out of it is outside.
  const rel = relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('the picture must lie inside the working directory');
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('not a regular file');
  if (stat.size === 0) throw new Error('empty file');
  if (stat.size > AVATAR_MAX_BYTES) {
    throw new Error(`image too large (${stat.size} bytes, max ${AVATAR_MAX_BYTES})`);
  }
  return { mime, data: fs.readFileSync(real).toString('base64') };
}
