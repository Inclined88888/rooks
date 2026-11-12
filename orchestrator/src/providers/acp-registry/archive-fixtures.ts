/** Test builders for the archives `archive.ts` opens (tar.gz with modes, zip). */
import { deflateRawSync, gzipSync } from 'node:zlib';

export type FixtureFile = { path: string; data?: string | Buffer; type?: '0' | '1' | '2' | '5'; mode?: number; link?: string };

export function buildTarGzWithModes(files: readonly FixtureFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = f.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const header = Buffer.alloc(512);
    header.write(f.path.slice(0, 100), 0, 'utf8');
    header.write(`${(f.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 'ascii');
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

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipFixture = { path: string; data?: string | Buffer; stored?: boolean; unixMode?: number; symlink?: boolean; encrypted?: boolean };

export function buildZip(files: readonly ZipFixture[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = f.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const name = Buffer.from(f.path, 'utf8');
    const method = f.stored || raw.length === 0 ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const flags = f.encrypted ? 1 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const unix = f.symlink ? 0o120777 : (f.unixMode ?? 0o644) | (f.path.endsWith('/') ? 0o040000 : 0o100000);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((unix << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
