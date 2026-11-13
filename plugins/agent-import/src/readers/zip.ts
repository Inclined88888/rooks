/**
 * Reading an agent setup from a zip the user uploaded.
 *
 * The archive is untrusted input, so everything that can be decided from its
 * central directory is decided there, before a single entry is inflated:
 * entry count, declared expanded size of the whole archive, expansion ratio
 * of each entry, Zip-Slip names, duplicates, links, the deny list, `wants`,
 * and the per-file and per-skill ceilings. Only the entries that survive are
 * then inflated (with `fflate`), each one stopped as soon as it outgrows the
 * size it declared, and checked against its CRC.
 *
 * Names: `\` is a separator (the Windows Explorer writes it). A name flagged
 * UTF-8 must be valid UTF-8. An unflagged one is taken as UTF-8 when it is
 * valid (macOS and Linux tools write UTF-8 without the flag), from its Info-ZIP
 * Unicode Path field when it has one (7-Zip), and otherwise decoded as the
 * Windows OEM code page 850 — what a western-European Windows Explorer
 * writes — with a notice, since that last one is a guess.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { Inflate } from 'fflate';
import { resolveLimits, ZIP_UPLOAD_MAX_BYTES, type ReaderLimits } from './limits.js';
import {
  archiveEntrySegments, compileWants, deniedPrefix, globMatches, isNestedArchive, isUnportableSegment,
  planSelection, ReaderError, type Candidate, type SkippedEntry, type SourceTree, type TreeNotice,
} from './policy.js';

export type ZipReadOptions = {
  limits?: Partial<ReaderLimits>;
  /** Size of the archive file itself; never above ZIP_UPLOAD_MAX_BYTES. */
  maxArchiveBytes?: number;
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_MIN = 22;
const CENTRAL_MIN = 46;
const LOCAL_MIN = 30;
const MAX_COMMENT = 0xffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

const HOST_UNIX = 3;
const HOST_DARWIN = 19;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const DOS_DIRECTORY = 0x10;

/** Compressed bytes handed to the inflater at once: bounds the output of one step to ~64 MiB. */
const INFLATE_SLICE = 64 * 1024;

/* ── CRC-32 ─────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

class Crc32 {
  private c = 0xffffffff;
  update(bytes: Uint8Array): void {
    let c = this.c;
    for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
    this.c = c;
  }
  digest(): number {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

function crc32(bytes: Uint8Array): number {
  const crc = new Crc32();
  crc.update(bytes);
  return crc.digest();
}

/* ── Names ──────────────────────────────────────────────────────────────── */

// Code page 850, bytes 0x80–0xFF.
const CP850_HIGH = // french-ok: the code page's own accented letters, byte for byte
  'ÇüéâäàåçêëèïîìÄÅ' + 'ÉæÆôöòûùÿÖÜø£Ø×ƒ' + 'áíóúñÑªº¿®¬½¼¡«»' + '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐'
  + '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' + 'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' + 'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' + '­±‗¾¶§÷¸°¨·¹³²■ ';

const CP850 = Array.from(CP850_HIGH);

function decodeCp850(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : (CP850[b - 0x80] ?? '�');
  return out;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

function decodeName(raw: Uint8Array, flags: number, unicodePath: Uint8Array | null): { name: string; guessed: boolean } {
  if (flags & FLAG_UTF8) {
    const name = tryUtf8(raw);
    if (name === null) throw new ReaderError('corrupt', 'archive entry name is flagged UTF-8 but is not');
    return { name, guessed: false };
  }
  const fromField = unicodePath ? tryUtf8(unicodePath) : null;
  if (fromField !== null) return { name: fromField, guessed: false };
  const asUtf8 = tryUtf8(raw);
  if (asUtf8 !== null) return { name: asUtf8, guessed: false };
  return { name: decodeCp850(raw), guessed: true };
}

/* ── Central directory ──────────────────────────────────────────────────── */

type CentralEntry = {
  rawName: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(out, done, length - done, offset + done);
    if (bytesRead === 0) throw new ReaderError('corrupt', 'archive is truncated');
    done += bytesRead;
  }
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The end-of-central-directory record, searched backwards past a comment. */
function findEocd(tail: Uint8Array): number {
  const dv = view(tail);
  for (let at = tail.length - EOCD_MIN; at >= 0; at--) {
    if (dv.getUint32(at, true) !== SIG_EOCD) continue;
    // The comment must end exactly at the end of the file: a signature lying
    // inside a comment or an entry would otherwise be taken for the real one.
    if (at + EOCD_MIN + dv.getUint16(at + 20, true) === tail.length) return at;
  }
  return -1;
}

type ExtraFields = { zip64: Uint8Array | null; unicodePath: Uint8Array | null };

function extraFields(extra: Uint8Array): ExtraFields {
  const dv = view(extra);
  const out: ExtraFields = { zip64: null, unicodePath: null };
  for (let at = 0; at + 4 <= extra.length;) {
    const id = dv.getUint16(at, true);
    const len = dv.getUint16(at + 2, true);
    const body = extra.subarray(at + 4, at + 4 + len);
    if (body.length !== len) throw new ReaderError('corrupt', 'archive entry has a truncated extra field');
    if (id === 0x0001) out.zip64 = body;
    if (id === 0x7075) out.unicodePath = body;
    at += 4 + len;
  }
  return out;
}

/** Info-ZIP Unicode Path: version 1, CRC of the header name it replaces, UTF-8 name. */
function unicodePathFor(field: Uint8Array | null, rawName: Uint8Array): Uint8Array | null {
  if (!field || field.length < 5 || field[0] !== 1) return null;
  return view(field).getUint32(1, true) === crc32(rawName) ? field.subarray(5) : null;
}

type ListedEntry = CentralEntry & { externalAttr: number; host: number; unicodePath: Uint8Array | null };
type Listing = { entries: ListedEntry[]; cdStart: number };

async function readCentralDirectory(handle: FileHandle, fileSize: number, limits: ReaderLimits): Promise<Listing> {
  if (fileSize < EOCD_MIN) throw new ReaderError('corrupt', 'not a zip archive');
  const tailLength = Math.min(fileSize, EOCD_MIN + MAX_COMMENT);
  const tailStart = fileSize - tailLength;
  const tail = await readAt(handle, tailStart, tailLength);
  const eocdAt = findEocd(tail);
  if (eocdAt === -1) throw new ReaderError('corrupt', 'not a zip archive (no central directory)');
  const eocd = view(tail.subarray(eocdAt));
  const disk = eocd.getUint16(4, true);
  const cdDisk = eocd.getUint16(6, true);
  const onDisk = eocd.getUint16(8, true);
  const count = eocd.getUint16(10, true);
  const cdSize = eocd.getUint32(12, true);
  const cdStart = eocd.getUint32(16, true);
  const hasZip64Locator = eocdAt >= 20 && view(tail).getUint32(eocdAt - 20, true) === SIG_ZIP64_LOCATOR;
  if (hasZip64Locator && (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff)) {
    // Needing ZIP64 records means more than 65,535 entries or 4 GiB: far past every ceiling anyway.
    throw new ReaderError('unsupported', 'ZIP64 archives are not supported');
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) {
    throw new ReaderError('unsupported', 'multi-part zip archives are not supported');
  }
  if (count > limits.maxFiles) {
    throw new ReaderError('too-many-files', `the archive holds more than ${limits.maxFiles} entries`);
  }
  const eocdOffset = tailStart + eocdAt;
  if (cdStart + cdSize > eocdOffset) throw new ReaderError('corrupt', 'archive central directory is out of bounds');

  const cd = await readAt(handle, cdStart, cdSize);
  const dv = view(cd);
  const entries: Listing['entries'] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_MIN > cd.length || dv.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ReaderError('corrupt', 'archive central directory is malformed');
    }
    const host = dv.getUint8(at + 5);
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const crc = dv.getUint32(at + 16, true);
    let compressedSize = dv.getUint32(at + 20, true);
    let size = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const externalAttr = dv.getUint32(at + 38, true);
    let localOffset = dv.getUint32(at + 42, true);
    const end = at + CENTRAL_MIN + nameLength + extraLength + commentLength;
    if (end > cd.length) throw new ReaderError('corrupt', 'archive central directory is malformed');
    const rawName = cd.slice(at + CENTRAL_MIN, at + CENTRAL_MIN + nameLength);
    const extra = extraFields(cd.subarray(at + CENTRAL_MIN + nameLength, at + CENTRAL_MIN + nameLength + extraLength));
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      // ZIP64 extended information: present fields, in this order, only for the saturated ones.
      const z = extra.zip64 ? view(extra.zip64) : null;
      let zi = 0;
      const next = (): number => {
        if (!z || zi + 8 > z.byteLength) throw new ReaderError('corrupt', 'archive entry has a malformed ZIP64 field');
        const value = z.getBigUint64(zi, true);
        zi += 8;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReaderError('too-large', 'archive entry is too large');
        return Number(value);
      };
      if (size === 0xffffffff) size = next();
      if (compressedSize === 0xffffffff) compressedSize = next();
      if (localOffset === 0xffffffff) localOffset = next();
    }
    entries.push({
      rawName, flags, method, crc, compressedSize, size, localOffset, externalAttr, host, unicodePath: extra.unicodePath,
    });
    at = end;
  }
  return { entries, cdStart };
}

/* ── Inflating ──────────────────────────────────────────────────────────── */

function inflateEntry(compressed: Uint8Array, entry: CentralEntry, path: string): Uint8Array {
  const out = new Uint8Array(entry.size);
  if (entry.method === METHOD_STORED) {
    if (entry.compressedSize !== entry.size) throw new ReaderError('corrupt', `${path}: stored entry with two different sizes`);
    out.set(compressed);
  } else {
    let produced = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      if (produced + chunk.length > entry.size) {
        throw new ReaderError('bomb', `${path} expands beyond the size it declares`);
      }
      out.set(chunk, produced);
      produced += chunk.length;
      if (final) finished = true;
    });
    try {
      for (let at = 0; at < compressed.length; at += INFLATE_SLICE) {
        const end = Math.min(at + INFLATE_SLICE, compressed.length);
        inflater.push(compressed.subarray(at, end), end === compressed.length);
      }
      if (compressed.length === 0) inflater.push(new Uint8Array(0), true);
    } catch (err) {
      if (err instanceof ReaderError) throw err;
      throw new ReaderError('corrupt', `${path} could not be decompressed`);
    }
    if (!finished || produced !== entry.size) throw new ReaderError('corrupt', `${path} is shorter than it declares`);
  }
  if (crc32(out) !== entry.crc) throw new ReaderError('corrupt', `${path} fails its checksum`);
  return out;
}

/* ── Reader ─────────────────────────────────────────────────────────────── */

type EntryRef = CentralEntry & { path: string };

function fileType(host: number, externalAttr: number, name: string): 'file' | 'dir' | 'link' | 'special' {
  if (name.endsWith('/') || name.endsWith('\\')) return 'dir';
  if (host === HOST_UNIX || host === HOST_DARWIN) {
    const mode = (externalAttr >>> 16) & S_IFMT;
    if (mode === S_IFLNK) return 'link';
    if (mode === S_IFDIR) return 'dir';
    if (mode !== 0 && mode !== S_IFREG) return 'special';
  }
  if (externalAttr & DOS_DIRECTORY) return 'dir';
  return 'file';
}

/**
 * Reads the zip at `file` (a temporary file the daemon itself wrote, see
 * `stageUpload`), and returns the entries that pass the deny list THEN one of
 * the `wants` globs, as relative POSIX path → bytes. Line endings are left as
 * they are: normalising them is each adapter's business.
 */
export async function readZipFile(file: string, wants: readonly string[], options: ZipReadOptions = {}): Promise<SourceTree> {
  const limits = resolveLimits(options.limits);
  const globs = compileWants(wants);
  const maxArchiveBytes = Math.min(options.maxArchiveBytes ?? ZIP_UPLOAD_MAX_BYTES, ZIP_UPLOAD_MAX_BYTES);

  const handle = await open(file, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new ReaderError('corrupt', 'the archive is not a file');
    if (st.size > maxArchiveBytes) throw new ReaderError('too-large', `the archive is larger than ${maxArchiveBytes} bytes`);
    const { entries, cdStart } = await readCentralDirectory(handle, st.size, limits);

    // Ceilings on the whole archive, before anything is inflated.
    let declared = 0;
    for (const e of entries) {
      declared += e.size;
      if (declared > limits.maxBytes) {
        throw new ReaderError('too-large', `the archive expands beyond ${limits.maxBytes} bytes`);
      }
      if (e.size > limits.ratioFloorBytes && e.size / Math.max(e.compressedSize, 1) > limits.maxRatio) {
        throw new ReaderError('bomb', 'the archive holds an entry with an implausible expansion ratio');
      }
    }

    const skipped: SkippedEntry[] = [];
    const notices: TreeNotice[] = [];
    const reportedPrefixes = new Set<string>();
    const seen = new Set<string>();
    const candidates: Candidate<EntryRef>[] = [];
    for (const e of entries) {
      const { name, guessed } = decodeName(e.rawName, e.flags, unicodePathFor(e.unicodePath, e.rawName));
      const segments = archiveEntrySegments(name);
      const type = fileType(e.host, e.externalAttr, name);
      if (segments.length === 0) {
        if (type === 'dir') continue;
        throw new ReaderError('unsafe-path', 'archive entry without a name');
      }
      const path = segments.join('/');
      if (type === 'dir') continue;
      // Two entries with one name are how an archive shows one reader one
      // file and another reader another: the whole archive is refused.
      if (seen.has(path)) throw new ReaderError('corrupt', `archive holds ${JSON.stringify(path)} twice`);
      seen.add(path);

      const denied = deniedPrefix(segments);
      if (denied !== null) {
        if (!reportedPrefixes.has(denied)) {
          reportedPrefixes.add(denied);
          skipped.push({ path: denied, reason: 'blocked' });
        }
        continue;
      }
      if (!globs.some((g) => globMatches(g, segments))) continue;
      if (type === 'link' || type === 'special') {
        skipped.push({ path, reason: type });
        continue;
      }
      if (isNestedArchive(segments[segments.length - 1] ?? '')) {
        skipped.push({ path, reason: 'nested-archive' });
        continue;
      }
      if (segments.some(isUnportableSegment)) {
        skipped.push({ path, reason: 'unportable-name' });
        continue;
      }
      if (guessed) notices.push({ path, code: 'name-not-utf8' });
      candidates.push({
        path,
        size: e.size,
        ref: {
          rawName: e.rawName, flags: e.flags, method: e.method, crc: e.crc,
          compressedSize: e.compressedSize, size: e.size, localOffset: e.localOffset, path,
        },
      });
    }

    const plan = planSelection(candidates, limits);
    for (const c of plan.keep) {
      if (c.ref.flags & FLAG_ENCRYPTED) throw new ReaderError('unsupported', `${c.path} is encrypted`);
      if (c.ref.method !== METHOD_STORED && c.ref.method !== METHOD_DEFLATED) {
        throw new ReaderError('unsupported', `${c.path} uses an unsupported compression method`);
      }
    }

    // Where each kept entry's data lies, checked against its local header,
    // the central directory and its neighbours: overlapping entries are the
    // way a small archive declares many large files out of one payload.
    const spans: { start: number; end: number; ref: EntryRef }[] = [];
    for (const c of plan.keep) {
      const header = await readAt(handle, c.ref.localOffset, LOCAL_MIN);
      const hv = view(header);
      if (hv.getUint32(0, true) !== SIG_LOCAL) throw new ReaderError('corrupt', `${c.path}: local header not found`);
      const nameLength = hv.getUint16(26, true);
      const extraLength = hv.getUint16(28, true);
      const localName = await readAt(handle, c.ref.localOffset + LOCAL_MIN, nameLength);
      if (localName.length !== c.ref.rawName.length || localName.some((b, i) => b !== c.ref.rawName[i])) {
        throw new ReaderError('corrupt', `${c.path}: local and central names differ`);
      }
      const start = c.ref.localOffset + LOCAL_MIN + nameLength + extraLength;
      const end = start + c.ref.compressedSize;
      if (end > cdStart) throw new ReaderError('corrupt', `${c.path}: data runs into the central directory`);
      spans.push({ start: c.ref.localOffset, end, ref: c.ref });
    }
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if (prev && cur && cur.start < prev.end) throw new ReaderError('corrupt', 'archive entries overlap');
    }

    const files = new Map<string, Uint8Array>();
    let totalBytes = 0;
    for (const span of spans) {
      const compressed = await readAt(handle, span.end - span.ref.compressedSize, span.ref.compressedSize);
      files.set(span.ref.path, inflateEntry(compressed, span.ref, span.ref.path));
      totalBytes += span.ref.size;
    }
    skipped.push(...plan.skipped);
    skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, skipped, notices, totalBytes };
  } finally {
    await handle.close();
  }
}
