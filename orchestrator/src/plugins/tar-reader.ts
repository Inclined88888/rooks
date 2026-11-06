/**
 * Bounded reader for a plugin archive — the `.tgz` that `npm pack` produces
 * and that `timon plugin add` already accepts.
 *
 * Written here rather than pulled from npm (rule 12): `tar-fs`/`tar-stream`
 * are only transitive dependencies of the tree, and a plugin archive needs
 * nothing more than gunzip (`node:zlib`) and the 512-byte ustar header.
 *
 * The archive is attacker-supplied, so every limit is enforced BEFORE a byte
 * lands on disk: compressed size, inflated size (`maxOutputLength`, so a zip
 * bomb is cut by zlib itself), entry count, and the path of each entry. Only
 * regular files and directories are accepted — a symbolic or hard link could
 * point outside the target, and a signed plugin may not contain one anyway
 * (`signature.ts`).
 *
 * Like npm, the first path component (`package/`) is stripped. Unlike npm, an
 * archive whose entries do not share ONE top folder is refused: that is not
 * what `npm pack` makes, and guessing would extract something else than what
 * npm will install.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { windowsSegmentProblem } from '../host/portable-names.js';

export type TarLimits = {
  /** Compressed bytes. */
  maxArchiveBytes: number;
  /** Inflated bytes, headers included. */
  maxExpandedBytes: number;
  maxEntries: number;
};

export const DEFAULT_TAR_LIMITS: TarLimits = Object.freeze({
  maxArchiveBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxEntries: 10_000,
});

export class TarError extends Error {
  constructor(readonly code: 'too-large' | 'not-gzip' | 'corrupt' | 'too-many-entries' | 'unsafe-path' | 'link' | 'layout', message: string) {
    super(message);
    this.name = 'TarError';
  }
}

export type TarEntry = { path: string; type: 'file' | 'dir'; data: Buffer };

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, length: number): number {
  const raw = cString(buf, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new TarError('corrupt', 'invalid size field in archive header');
  return Number.parseInt(raw, 8);
}

/** `path=` record of a pax extended header, the only key that matters here. */
function paxPath(data: Buffer): string | null {
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    if (record.startsWith('path=')) return record.slice('path='.length);
    offset += length;
  }
  return null;
}

/**
 * A relative, forward-slash path with no `..`, no drive letter, no NUL. The
 * caller still checks containment after `resolve` — this is the first wall,
 * not the only one.
 */
function safeSegments(raw: string): string[] {
  if (raw.includes('\0') || raw.includes('\\')) throw new TarError('unsafe-path', 'archive entry with an unsafe path');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || isAbsolute(raw)) {
    throw new TarError('unsafe-path', 'archive entry with an absolute path');
  }
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new TarError('unsafe-path', 'archive entry escaping its folder (`..`)');
  // Every OS, like the zip reader: a plugin must install on Windows too (TODO #541).
  for (const part of parts) {
    const problem = windowsSegmentProblem(part);
    if (problem) throw new TarError('unsafe-path', `archive entry ${JSON.stringify(parts.join('/'))} has ${problem}`);
  }
  return parts;
}

/** Reads every entry of a `.tgz` in memory, top folder stripped. Nothing is written. */
export function readTarGz(archive: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): TarEntry[] {
  if (archive.length > limits.maxArchiveBytes) throw new TarError('too-large', 'archive is larger than the allowed size');
  if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
    throw new TarError('not-gzip', 'not a gzip archive (expected a .tgz made by `npm pack`)');
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: limits.maxExpandedBytes });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || /too large|maxOutputLength/i.test((err as Error).message)) {
      throw new TarError('too-large', 'archive expands beyond the allowed size');
    }
    throw new TarError('corrupt', 'archive could not be decompressed');
  }

  const entries: TarEntry[] = [];
  let top: string | null = null;
  let longName: string | null = null;
  let offset = 0;
  let headers = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    if (++headers > limits.maxEntries * 2) throw new TarError('too-many-entries', 'archive has too many entries');
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new TarError('corrupt', 'archive is truncated');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    // Metadata records describe the NEXT entry; global ones are ignored.
    if (type === 'x') { longName = paxPath(data) ?? longName; continue; }
    if (type === 'L') { longName = cString(data, 0, data.length); continue; }
    if (type === 'g') continue;

    const prefix = cString(header, 345, 155);
    const name = cString(header, 0, 100);
    const raw = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;

    if (type === '1' || type === '2') throw new TarError('link', 'archive contains a link — not allowed in a plugin');
    const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : null;
    if (kind === null) throw new TarError('link', 'archive contains a special entry (device, fifo…) — not allowed');

    const parts = safeSegments(raw);
    if (parts.length === 0) continue;
    const head = parts[0] as string;
    if (top === null) top = head;
    else if (top !== head) throw new TarError('layout', 'archive must hold a single top folder (as `npm pack` makes it)');
    const rest = parts.slice(1);
    if (rest.length === 0) {
      if (kind === 'file') throw new TarError('layout', 'archive must hold a single top folder (as `npm pack` makes it)');
      continue;
    }
    if (entries.length >= limits.maxEntries) throw new TarError('too-many-entries', 'archive has too many entries');
    entries.push({ path: rest.join('/'), type: kind, data: kind === 'file' ? Buffer.from(data) : Buffer.alloc(0) });
  }
  if (entries.length === 0) throw new TarError('layout', 'archive is empty');
  return entries;
}

/**
 * Extracts into `dest` (created). Each entry is resolved and checked to stay
 * inside `dest` — the zip-slip wall that does not rely on the regex above.
 */
export function extractTarGz(archive: Buffer, dest: string, limits: TarLimits = DEFAULT_TAR_LIMITS): number {
  const entries = readTarGz(archive, limits);
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const target = resolve(root, ...entry.path.split('/'));
    if (target === root || !target.startsWith(root + sep)) {
      throw new TarError('unsafe-path', 'archive entry escaping its folder');
    }
    if (entry.type === 'dir') { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data, { flag: 'wx' });
  }
  return entries.length;
}

/** Test helper and the reverse of the reader: a minimal ustar `.tgz`. */
export function buildTarGz(files: ReadonlyArray<{ path: string; data?: string | Buffer; type?: '0' | '1' | '2' | '5'; link?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = f.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const header = Buffer.alloc(512);
    header.write(f.path.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write(f.type ?? '0', 156, 'ascii');
    if (f.link) header.write(f.link.slice(0, 100), 157, 'utf8');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
