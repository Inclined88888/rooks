/**
 * A minimal, read-only zip reader for Office Open XML files, with no
 * dependency: the central directory is parsed by hand and entries are
 * inflated by the browser's own `DecompressionStream`.
 *
 * The file is untrusted, so everything is bounded: the entry count, and the
 * bytes an entry may inflate to (checked while streaming, not from the sizes
 * the archive declares — a zip bomb lies about them).
 */

export class PreviewError extends Error {
  constructor(readonly code: 'unsupported' | 'corrupt' | 'too_large', message: string) {
    super(message);
  }
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRIES = 20_000;
/** What one XML part may inflate to. */
export const MAX_PART_BYTES = 64 * 1024 * 1024;

type Entry = { method: number; compressed: number; offset: number };

export class Zip {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly entries = new Map<string, Entry>();

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.readDirectory();
  }

  private readDirectory(): void {
    const len = this.bytes.length;
    // The end-of-directory record sits within the last 64 KiB + 22 bytes.
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
      if (this.view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new PreviewError('corrupt', 'not a zip archive');
    const count = this.view.getUint16(eocd + 10, true);
    const size = this.view.getUint32(eocd + 12, true);
    const offset = this.view.getUint32(eocd + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new PreviewError('unsupported', 'zip64 archives are not supported');
    }
    if (count > MAX_ENTRIES) throw new PreviewError('too_large', 'too many entries');
    const decoder = new TextDecoder('utf-8');
    let p = offset;
    for (let n = 0; n < count; n++) {
      if (p + 46 > len || this.view.getUint32(p, true) !== CENTRAL_SIG) throw new PreviewError('corrupt', 'bad central directory');
      const flags = this.view.getUint16(p + 8, true);
      const method = this.view.getUint16(p + 10, true);
      const compressed = this.view.getUint32(p + 20, true);
      const nameLen = this.view.getUint16(p + 28, true);
      const extraLen = this.view.getUint16(p + 30, true);
      const commentLen = this.view.getUint16(p + 32, true);
      const localOffset = this.view.getUint32(p + 42, true);
      if (p + 46 + nameLen > len) throw new PreviewError('corrupt', 'bad central directory');
      const name = decoder.decode(this.bytes.subarray(p + 46, p + 46 + nameLen));
      if ((flags & 1) === 0) this.entries.set(name, { method, compressed, offset: localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  async bytesOf(name: string, max = MAX_PART_BYTES): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new PreviewError('corrupt', `missing part ${name}`);
    const at = entry.offset;
    if (at + 30 > this.bytes.length || this.view.getUint32(at, true) !== LOCAL_SIG) {
      throw new PreviewError('corrupt', `bad local header for ${name}`);
    }
    const start = at + 30 + this.view.getUint16(at + 26, true) + this.view.getUint16(at + 28, true);
    const end = start + entry.compressed;
    if (end > this.bytes.length) throw new PreviewError('corrupt', `truncated part ${name}`);
    const data = this.bytes.subarray(start, end);
    if (entry.method === 0) {
      if (data.length > max) throw new PreviewError('too_large', `${name} is too large`);
      return data;
    }
    if (entry.method !== 8) throw new PreviewError('unsupported', `unsupported compression in ${name}`);
    return inflate(data, max, name);
  }

  async text(name: string, max = MAX_PART_BYTES): Promise<string> {
    const text = new TextDecoder('utf-8').decode(await this.bytesOf(name, max));
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
}

async function inflate(data: Uint8Array, max: number, name: string): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        throw new PreviewError('too_large', `${name} is too large`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PreviewError) throw err;
    throw new PreviewError('corrupt', `cannot inflate ${name}`);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
