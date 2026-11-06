/**
 * A zip writer for tests only, byte by byte, so that a test can forge exactly
 * the archive a hostile or exotic tool would produce: `..` names, raw
 * non-UTF-8 names, `\` separators, symbolic links, sizes that lie, duplicate
 * or overlapping entries. No real zip library would write most of these.
 */
import { deflateRawSync } from 'node:zlib';

export type ForgedEntry = {
  /** A string is written as UTF-8; bytes are written as given. */
  name: string | Uint8Array;
  data?: string | Uint8Array;
  method?: 0 | 8;
  /** Defaults to true for a string name. */
  utf8Flag?: boolean;
  encrypted?: boolean;
  /** Host 3 (Unix) with this st_mode in the external attributes. */
  unixMode?: number;
  /** Host 0 (MS-DOS) with these attributes (0x10 = directory). */
  dosAttr?: number;
  /** Lies about the expanded size in the central directory. */
  declaredSize?: number;
  /** Replaces the compressed payload (garbage deflate, truncated data…). */
  payload?: Uint8Array;
  crc?: number;
  /** Extra field of the central record. */
  extra?: Uint8Array;
  /** Points the central record somewhere else (overlapping entries). */
  localOffset?: number;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const bytesOf = (v: string | Uint8Array): Uint8Array => (typeof v === 'string' ? new TextEncoder().encode(v) : v);

/** Info-ZIP Unicode Path extra field (0x7075) for a raw header name. */
export function unicodePathExtra(rawName: Uint8Array, utf8Name: string): Uint8Array {
  const name = bytesOf(utf8Name);
  const out = Buffer.alloc(4 + 5 + name.length);
  out.writeUInt16LE(0x7075, 0);
  out.writeUInt16LE(5 + name.length, 2);
  out.writeUInt8(1, 4);
  out.writeUInt32LE(crc32(rawName), 5);
  Buffer.from(name).copy(out, 9);
  return out;
}

export function forgeZip(entries: readonly ForgedEntry[], comment = ''): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = bytesOf(e.name);
    const data = bytesOf(e.data ?? '');
    const method = e.method ?? 8;
    const payload = e.payload ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = e.crc ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    let flags = 0;
    if (e.utf8Flag ?? typeof e.name === 'string') flags |= 0x0800;
    if (e.encrypted) flags |= 0x0001;
    const host = e.unixMode !== undefined ? 3 : 0;
    const external = e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : (e.dosAttr ?? 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, Buffer.from(name), Buffer.from(payload)]);

    const extra = e.extra ?? new Uint8Array(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((host << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(e.localOffset ?? offset, 42);
    centrals.push(Buffer.concat([central, Buffer.from(name), Buffer.from(extra)]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const cd = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, cd, eocd, commentBytes]);
}
