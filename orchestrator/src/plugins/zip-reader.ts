/**
 * Bounded reader for a plugin shipped as a `.zip` (TODO #345) — what GitHub's
 * "Download ZIP", the Windows Explorer and the macOS Finder produce.
 *
 * No dependency (rule 12, the maintainer's call): the central directory is a fixed
 * layout and deflate is `node:zlib`'s `inflateRawSync`. Same walls as
 * `tar-reader.ts`, enforced BEFORE a byte lands on disk: compressed size,
 * declared inflated size summed over every entry (overlapping entries are the
 * non-recursive zip bomb), each entry inflated with `maxOutputLength` = its
 * declared size and checked against its CRC, entry count, and the path of each
 * entry. `providers/acp-registry/archive.ts` also opens zips, but streams them
 * to disk with their layout kept as published; a plugin needs the layout
 * normalised below and the bytes in memory, so the two stay apart.
 *
 * Refused with a code of its own, so the UI can say why: zip64, encrypted
 * entries, multi-volume (split/spanned) archives, any compression other than
 * stored/deflate. Links (Unix mode in the external attributes) and anything
 * that is neither a file nor a folder are refused like in the tar reader.
 *
 * A Windows tool may write `\` as separator (Windows PowerShell's
 * `Compress-Archive` does): it is read as `/` BEFORE the path checks, so
 * `..\x` is still a `..` and refused.
 *
 * Layout, decided here and documented in docs/PLUGINS.md:
 *  - `__MACOSX/` and `.DS_Store` (Finder metadata) are dropped first — they
 *    are not part of a plugin, and a signed plugin zipped by the Finder would
 *    otherwise read as tampered;
 *  - a `package.json` at the root of the zip → the root is the package (files
 *    zipped from inside the plugin folder);
 *  - otherwise ONE top folder, stripped (`repo-main/` from GitHub, `package/`
 *    like `npm pack`, `my-plugin/` from "Compress");
 *  - anything else, or no `package.json` once stripped, is refused.
 */
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { windowsSegmentProblem } from '../host/portable-names.js';
import { DEFAULT_TAR_LIMITS, type TarEntry, type TarLimits } from './tar-reader.js';

export type ZipErrorCode =
  | 'too-large' | 'not-zip' | 'corrupt' | 'too-many-entries' | 'unsafe-path' | 'link' | 'layout'
  | 'zip64' | 'encrypted' | 'multi-volume' | 'compression';

export class ZipError extends Error {
  constructor(readonly code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const SPANNED_SIG = 0x08074b50;
const END_MIN = 22;
const HOST_UNIX = 3;
const HOST_OSX = 19;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const DOS_DIRECTORY = 0x10;

/** `PK\3\4` (an entry first) or `PK\5\6` (an empty zip). Sniffed, never trusted to a name or a MIME type. */
export function isZip(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  const sig = buf.readUInt32LE(0);
  return sig === LOCAL_SIG || sig === END_SIG || sig === SPANNED_SIG;
}

let CRC_TABLE: Uint32Array | null = null;

/** Local table rather than `zlib.crc32`, which older Node runtimes lack. */
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Same first wall as the tar reader, after `\` is read as a separator. */
function safeSegments(raw: string): string[] {
  const name = raw.replaceAll('\\', '/');
  if (name.includes('\0')) throw new ZipError('unsafe-path', 'archive entry with an unsafe path');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || isAbsolute(name)) {
    throw new ZipError('unsafe-path', 'archive entry with an absolute path');
  }
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new ZipError('unsafe-path', 'archive entry escaping its folder (`..`)');
  return parts;
}

function isFinderJunk(parts: readonly string[]): boolean {
  const last = parts[parts.length - 1];
  // `Icon\r` holds a folder's custom Finder icon: metadata, and a name Windows refuses.
  return parts[0] === '__MACOSX' || last === '.DS_Store' || last === 'Icon\r';
}

type CentralEntry = {
  parts: string[];
  dir: boolean;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
};

/** The end-of-central-directory record, searched from the end (a comment may follow it). */
function findEnd(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - END_MIN - 0xffff);
  for (let i = archive.length - END_MIN; i >= lowest; i -= 1) {
    if (archive.readUInt32LE(i) !== END_SIG) continue;
    // A signature inside the comment is not the record: its comment length must end the file.
    if (i + END_MIN + archive.readUInt16LE(i + 20) === archive.length) return i;
  }
  throw new ZipError('corrupt', 'zip archive is truncated or damaged (no end record)');
}

function hasZip64Extra(extra: Buffer): boolean {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 0x0001) return true;
    at += 4 + length;
  }
  return false;
}

function centralDirectory(archive: Buffer, limits: TarLimits): { entries: CentralEntry[]; cdOffset: number } {
  if (archive.readUInt32LE(0) === SPANNED_SIG) {
    throw new ZipError('multi-volume', 'split or spanned zip archives are not supported — make a single .zip');
  }
  const end = findEnd(archive);
  if (end >= 20 && archive.readUInt32LE(end - 20) === ZIP64_LOCATOR_SIG) {
    throw new ZipError('zip64', 'zip64 archives are not supported');
  }
  const disk = archive.readUInt16LE(end + 4);
  const cdDisk = archive.readUInt16LE(end + 6);
  const onDisk = archive.readUInt16LE(end + 8);
  const total = archive.readUInt16LE(end + 10);
  const cdSize = archive.readUInt32LE(end + 12);
  const cdOffset = archive.readUInt32LE(end + 16);
  if (total === 0xffff || onDisk === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('zip64', 'zip64 archives are not supported');
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) {
    throw new ZipError('multi-volume', 'split or spanned zip archives are not supported — make a single .zip');
  }
  if (total > limits.maxEntries) throw new ZipError('too-many-entries', 'archive has too many entries');
  if (cdOffset + cdSize > end) throw new ZipError('corrupt', 'zip archive is truncated or damaged');

  const entries: CentralEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (at + 46 > cdOffset + cdSize || archive.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new ZipError('corrupt', 'zip archive is damaged (bad central directory)');
    }
    const host = archive.readUInt8(at + 5);
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const external = archive.readUInt32LE(at + 38);
    const offset = archive.readUInt32LE(at + 42);
    const nameEnd = at + 46 + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (next > cdOffset + cdSize) throw new ZipError('corrupt', 'zip archive is damaged (bad central directory)');
    const raw = archive.subarray(at + 46, nameEnd).toString('utf8');
    const extra = archive.subarray(nameEnd, nameEnd + extraLength);
    at = next;

    // Bit 0: traditional encryption; bit 6: strong encryption; method 99: AES.
    if (flags & 0x0001 || flags & 0x0040 || method === 99) {
      throw new ZipError('encrypted', 'password-protected zip archives are not supported');
    }
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff || hasZip64Extra(extra)) {
      throw new ZipError('zip64', 'zip64 archives are not supported');
    }
    const unixType = host === HOST_UNIX || host === HOST_OSX ? (external >>> 16) & S_IFMT : 0;
    if (unixType === S_IFLNK) throw new ZipError('link', 'archive contains a link — not allowed in a plugin');
    if (unixType !== 0 && unixType !== S_IFREG && unixType !== S_IFDIR) {
      throw new ZipError('link', 'archive contains a special entry (device, fifo…) — not allowed');
    }
    const dir = raw.endsWith('/') || raw.endsWith('\\') || unixType === S_IFDIR || (external & DOS_DIRECTORY) !== 0;
    entries.push({ parts: safeSegments(raw), dir, method, crc, compressed, size, offset });
  }
  return { entries, cdOffset };
}

function inflate(archive: Buffer, entry: CentralEntry, cdOffset: number): Buffer {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError('compression', 'this zip uses a compression method Rooks cannot read — use standard (deflate) compression');
  }
  if (entry.offset + 30 > cdOffset || archive.readUInt32LE(entry.offset) !== LOCAL_SIG) {
    throw new ZipError('corrupt', 'zip archive is damaged (bad entry header)');
  }
  // The local header's own lengths: they may differ from the central copy.
  const start = entry.offset + 30 + archive.readUInt16LE(entry.offset + 26) + archive.readUInt16LE(entry.offset + 28);
  const stop = start + entry.compressed;
  if (stop > cdOffset) throw new ZipError('corrupt', 'zip archive is truncated or damaged');
  const packed = archive.subarray(start, stop);
  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(packed);
  } else {
    try {
      data = inflateRawSync(packed, { maxOutputLength: Math.max(entry.size, 1) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || /too large|maxOutputLength/i.test((err as Error).message)) {
        throw new ZipError('too-large', 'zip entry inflates beyond its declared size');
      }
      throw new ZipError('corrupt', 'zip archive could not be decompressed');
    }
  }
  if (data.length !== entry.size) throw new ZipError('corrupt', 'zip entry does not match its declared size');
  if (crc32(data) !== entry.crc) throw new ZipError('corrupt', 'zip entry is damaged (checksum mismatch)');
  return data;
}

/**
 * Refused on every OS, not only on Windows: a plugin is installed on all three,
 * and its author must meet the refusal on their own machine rather than a
 * Windows tester meeting a raw write error (TODO #541).
 */
function assertPortable(parts: readonly string[]): void {
  for (const part of parts) {
    const problem = windowsSegmentProblem(part);
    if (problem) throw new ZipError('unsafe-path', `archive entry ${JSON.stringify(parts.join('/'))} has ${problem}`);
  }
}

const LAYOUT_MESSAGE = 'zip must hold a package.json at its root, or a single top folder that holds it';

/** Reads every entry of a `.zip` in memory, laid out as a package folder. Nothing is written. */
export function readZip(archive: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): TarEntry[] {
  if (archive.length > limits.maxArchiveBytes) throw new ZipError('too-large', 'archive is larger than the allowed size');
  if (archive.length < END_MIN || !isZip(archive)) throw new ZipError('not-zip', 'not a zip archive');
  const { entries: all, cdOffset } = centralDirectory(archive, limits);

  const kept = all.filter((e) => e.parts.length > 0 && !isFinderJunk(e.parts));
  for (const entry of kept) assertPortable(entry.parts);
  const rootIsPackage = kept.some((e) => !e.dir && e.parts.length === 1 && e.parts[0] === 'package.json');
  let strip = 0;
  if (!rootIsPackage) {
    const tops = new Set(kept.map((e) => e.parts[0]));
    if (tops.size !== 1 || kept.some((e) => !e.dir && e.parts.length === 1)) throw new ZipError('layout', LAYOUT_MESSAGE);
    strip = 1;
  }

  // Case-insensitive: `Foo.js` and `foo.js` are one file on macOS and Windows,
  // and which one survives would change the package (and its signature) per OS.
  const seen = new Map<string, 'file' | 'dir'>();
  let declared = 0;
  const laid: Array<{ entry: CentralEntry; path: string }> = [];
  for (const entry of kept) {
    const parts = entry.parts.slice(strip);
    if (parts.length === 0) continue;
    const path = parts.join('/');
    const key = path.toLowerCase();
    const type = entry.dir ? 'dir' : 'file';
    const previous = seen.get(key);
    if (previous && (previous === 'file' || type === 'file')) {
      throw new ZipError('layout', 'zip holds the same file twice (names may differ only by case)');
    }
    seen.set(key, type);
    if (!entry.dir) {
      declared += entry.size;
      if (declared > limits.maxExpandedBytes) throw new ZipError('too-large', 'archive expands beyond the allowed size');
    }
    laid.push({ entry, path });
  }
  if (!laid.some((l) => l.path === 'package.json' && !l.entry.dir)) {
    throw new ZipError('layout', LAYOUT_MESSAGE);
  }

  return laid.map(({ entry, path }) => ({
    path,
    type: entry.dir ? 'dir' : 'file',
    data: entry.dir ? Buffer.alloc(0) : inflate(archive, entry, cdOffset),
  }));
}

/**
 * Extracts into `dest` (created). Each entry is resolved and checked to stay
 * inside `dest` — the zip-slip wall that does not rely on the checks above.
 */
export function extractZip(archive: Buffer, dest: string, limits: TarLimits = DEFAULT_TAR_LIMITS): number {
  const entries = readZip(archive, limits);
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const target = resolve(root, ...entry.path.split('/'));
    if (target === root || !target.startsWith(root + sep)) {
      throw new ZipError('unsafe-path', 'archive entry escaping its folder');
    }
    try {
      if (entry.type === 'dir') { mkdirSync(target, { recursive: true }); continue; }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data, { flag: 'wx' });
    } catch (err) {
      // A file that is also a folder (`a` and `a/b`): a layout fault, not a daemon crash.
      const code = (err as { code?: string }).code;
      if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR') {
        throw new ZipError('layout', 'zip holds a file and a folder under the same name');
      }
      throw err;
    }
  }
  return entries.length;
}
