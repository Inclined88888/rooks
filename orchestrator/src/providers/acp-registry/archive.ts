/**
 * Opening the archive of a downloaded agent.
 *
 * The archive is attacker-reachable (a compromised release asset is exactly
 * what the sha256 is for, and half of the registry publishes none), so the
 * extraction is as strict as `plugins/tar-reader.ts` and differs from it in
 * the three ways an agent program needs:
 *  - it STREAMS (the Cursor package is 184 MB packed: a Buffer would double
 *    that), with a ceiling on the inflated size;
 *  - it keeps the layout as published — `./dist-package/cursor-agent` is a path
 *    inside the archive, nothing is stripped — and the executable bit
 *    (a 129 MB `node` ships beside the launcher and must stay runnable);
 *  - it also opens `.zip` (the Windows builds), by hand with `node:zlib`.
 *
 * Refused outright: absolute paths, `..`, backslash tricks, NUL, drive
 * letters, symbolic and hard links, devices, anything past the limits. The
 * resolved target of every entry is checked to stay inside the destination.
 */
import {
  chmodSync, closeSync, copyFileSync, createReadStream, fstatSync, mkdirSync, openSync, readSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { createGunzip, createInflateRaw } from 'node:zlib';
import { windowsSegmentProblem } from '../../host/portable-names.js';
import type { Readable } from 'node:stream';

export class ArchiveError extends Error {
  constructor(
    readonly code: 'unsafe-path' | 'link' | 'too-large' | 'too-many-entries' | 'corrupt' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export type ExtractLimits = { maxExpandedBytes: number; maxEntries: number };
export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = Object.freeze({
  maxExpandedBytes: 2 * 1024 ** 3,
  maxEntries: 50_000,
});

function segmentsOf(raw: string): string[] {
  const name = raw.replaceAll('\\', '/');
  if (name.includes('\0')) throw new ArchiveError('unsafe-path', 'archive entry with an unsafe path');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || isAbsolute(name)) {
    throw new ArchiveError('unsafe-path', 'archive entry with an absolute path');
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new ArchiveError('unsafe-path', 'archive entry escaping its folder (`..`)');
  // Only where it bites: an agent archive is built per OS, and a Linux build may
  // legitimately hold a name Windows refuses. Here it is a clean code, not a raw `fs` error.
  if (process.platform === 'win32') {
    for (const part of parts) {
      const problem = windowsSegmentProblem(part);
      if (problem) throw new ArchiveError('unsafe-path', `archive entry ${JSON.stringify(parts.join('/'))} has ${problem}`);
    }
  }
  return parts;
}

/** Where an entry lands, proven to be inside `root`. */
function targetOf(root: string, raw: string): string | null {
  const parts = segmentsOf(raw);
  if (parts.length === 0) return null;
  const target = resolve(root, ...parts);
  if (target === root || !target.startsWith(root + sep)) {
    throw new ArchiveError('unsafe-path', 'archive entry escaping its folder');
  }
  return target;
}

/** Runnable stays runnable, nothing else gains a bit. */
function modeOf(unixMode: number): number {
  return unixMode & 0o111 ? 0o755 : 0o644;
}

class Budget {
  private expanded = 0;
  private entries = 0;
  constructor(private readonly limits: ExtractLimits) {}
  entry(): void {
    if (++this.entries > this.limits.maxEntries) throw new ArchiveError('too-many-entries', 'archive has too many entries');
  }
  bytes(n: number): void {
    this.expanded += n;
    if (this.expanded > this.limits.maxExpandedBytes) throw new ArchiveError('too-large', 'archive expands beyond the allowed size');
  }
}

/* ── tar.gz ─────────────────────────────────────────────────────────────── */

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, length: number): number {
  const raw = cString(buf, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new ArchiveError('corrupt', 'invalid number in an archive header');
  return Number.parseInt(raw, 8);
}

function paxPath(data: Buffer): string | null {
  const text = data.toString('utf8');
  let offset = 0;
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

/** Streams a `.tar.gz` into `dest`, layout and executable bits preserved. */
export async function extractTarGz(file: string, dest: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<void> {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const budget = new Budget(limits);
  const source: Readable = createReadStream(file).pipe(createGunzip());
  const chunks = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let pending: Buffer = Buffer.alloc(0);

  const fill = async (min: number): Promise<boolean> => {
    while (pending.length < min) {
      let next: IteratorResult<Buffer>;
      try { next = await chunks.next(); } catch { throw new ArchiveError('corrupt', 'archive could not be decompressed'); }
      if (next.done) return false;
      pending = pending.length ? Buffer.concat([pending, next.value]) : next.value;
    }
    return true;
  };
  /** Feeds `size` bytes to `sink` (or drops them when `sink` is null). */
  const consume = async (size: number, sink: ((chunk: Buffer) => void) | null): Promise<void> => {
    let remaining = size;
    while (remaining > 0) {
      if (pending.length === 0 && !(await fill(1))) throw new ArchiveError('corrupt', 'archive is truncated');
      const take = Math.min(pending.length, remaining);
      sink?.(pending.subarray(0, take));
      pending = pending.subarray(take);
      remaining -= take;
    }
  };
  const readSmall = async (size: number): Promise<Buffer> => {
    if (size > 1024 * 1024) throw new ArchiveError('corrupt', 'archive metadata record is too large');
    const parts: Buffer[] = [];
    await consume(size, (chunk) => parts.push(Buffer.from(chunk)));
    return Buffer.concat(parts);
  };

  let longName: string | null = null;
  try {
    for (;;) {
      if (!(await fill(512))) break;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every((b) => b === 0)) break;
      const size = octal(header, 124, 12);
      const type = String.fromCharCode(header[156] ?? 0);
      const padding = (512 - (size % 512)) % 512;

      if (type === 'x' || type === 'L' || type === 'g') {
        const data = await readSmall(size);
        await consume(padding, null);
        if (type === 'x') longName = paxPath(data) ?? longName;
        else if (type === 'L') longName = cString(data, 0, data.length);
        continue;
      }
      const prefix = cString(header, 345, 155);
      const name = cString(header, 0, 100);
      const raw = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = null;

      if (type === '1' || type === '2') throw new ArchiveError('link', 'archive contains a link — not allowed');
      const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : null;
      if (kind === null) throw new ArchiveError('link', 'archive contains a special entry (device, fifo…) — not allowed');

      budget.entry();
      const target = targetOf(root, raw);
      if (kind === 'dir') {
        if (target) mkdirSync(target, { recursive: true });
        await consume(size + padding, null);
        continue;
      }
      if (!target) throw new ArchiveError('unsafe-path', 'archive file entry without a name');
      mkdirSync(dirname(target), { recursive: true });
      const fd = openSync(target, 'wx', 0o600);
      try {
        await consume(size, (chunk) => { budget.bytes(chunk.length); writeSync(fd, chunk); });
      } finally {
        closeSync(fd);
      }
      chmodSync(target, modeOf(octal(header, 100, 8)));
      await consume(padding, null);
    }
  } finally {
    source.destroy();
  }
}

/* ── zip ────────────────────────────────────────────────────────────────── */

type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number; unixMode: number; dir: boolean };

function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, out, done, length - done, position + done);
    if (n === 0) throw new ArchiveError('corrupt', 'archive is truncated');
    done += n;
  }
  return out;
}

function zipEntries(fd: number, limits: ExtractLimits): ZipEntry[] {
  const total = fstatSync(fd).size;
  const tailLength = Math.min(total, 65_557);
  const tail = readAt(fd, total - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError('corrupt', 'not a zip archive');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArchiveError('unsupported', 'zip64 archives are not supported');
  }
  if (count > limits.maxEntries) throw new ArchiveError('too-many-entries', 'archive has too many entries');
  const directory = readAt(fd, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new ArchiveError('corrupt', 'bad zip directory');
    const madeByHost = directory.readUInt8(at + 5);
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const compressed = directory.readUInt32LE(at + 20);
    const size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const external = directory.readUInt32LE(at + 38);
    const offset = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new ArchiveError('unsupported', 'encrypted zip entries are not supported');
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new ArchiveError('unsupported', 'zip64 archives are not supported');
    }
    const unixMode = madeByHost === 3 ? external >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw new ArchiveError('link', 'archive contains a symbolic link — not allowed');
    entries.push({ name, method, compressed, size, offset, unixMode, dir: name.endsWith('/') || name.endsWith('\\') });
  }
  return entries;
}

export async function extractZip(file: string, dest: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<void> {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const budget = new Budget(limits);
  const fd = openSync(file, 'r');
  try {
    for (const entry of zipEntries(fd, limits)) {
      budget.entry();
      const target = targetOf(root, entry.name);
      if (entry.dir) {
        if (target) mkdirSync(target, { recursive: true });
        continue;
      }
      if (!target) throw new ArchiveError('unsafe-path', 'archive file entry without a name');
      if (entry.method !== 0 && entry.method !== 8) throw new ArchiveError('unsupported', 'unsupported zip compression method');
      const local = readAt(fd, entry.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError('corrupt', 'bad zip entry header');
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      mkdirSync(dirname(target), { recursive: true });
      const out = openSync(target, 'wx', 0o600);
      try {
        let written = 0;
        const sink = (chunk: Buffer): void => {
          written += chunk.length;
          // Bounded by what the directory DECLARED, not by what the stream claims.
          if (written > entry.size) throw new ArchiveError('too-large', 'zip entry inflates beyond its declared size');
          budget.bytes(chunk.length);
          writeSync(out, chunk);
        };
        if (entry.compressed > 0) {
          const raw = createReadStream(file, { start, end: start + entry.compressed - 1 });
          const stream: Readable = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
          try {
            for await (const chunk of stream) sink(chunk as Buffer);
          } catch (err) {
            if (err instanceof ArchiveError) throw err;
            throw new ArchiveError('corrupt', 'zip entry could not be decompressed');
          } finally {
            raw.destroy();
            stream.destroy();
          }
        }
        if (written !== entry.size) throw new ArchiveError('corrupt', 'zip entry is shorter than declared');
      } finally {
        closeSync(out);
      }
      chmodSync(target, modeOf(entry.unixMode));
    }
  } finally {
    closeSync(fd);
  }
}

/* ── raw program ────────────────────────────────────────────────────────── */

/** A download that is the program itself. */
export function installRaw(file: string, dest: string, name: string): string {
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  const target = targetOf(root, basename(name.replaceAll('\\', '/')));
  if (!target) throw new ArchiveError('unsafe-path', 'program without a name');
  copyFileSync(file, target);
  chmodSync(target, 0o755);
  return target;
}
