import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pathSegments, type SpeechModel } from './speech-catalog/schema.js';

/**
 * Reads the protobuf of an ONNX graph, without the native runtime, and
 * refuses every tensor whose external data could live outside the model
 * folder (TODO #484).
 *
 * Why this exists: onnxruntime follows `external_data.location` wherever it
 * points. Measured with ORT 1.23.2: a graph patched to name
 * `../../../../etc/passwd` opened that file and only failed on an offset out
 * of range. A model imported by the user, or a plugin's pack whose sha256 is
 * correct (the author pins their own bytes), must therefore be read here
 * before the addon ever sees it.
 *
 * The rule is narrower than "inside the folder": a location is a bare file
 * name (no separator, no `..`, none of ORT's `*` tags) that names one of the
 * model's own files next to the graph. Every tensor is visited: initializers,
 * sparse initializers, constants and subgraphs held by node attributes,
 * functions and training graphs. The reader only follows the fields that can
 * hold a tensor and skips everything else by length, so a 650 MB encoder is
 * read in a few thousand small reads, never loaded whole.
 */

export type OnnxRefusalCode = 'malformed' | 'external-outside' | 'external-unknown-key' | 'too-complex';

export class OnnxRefused extends Error {
  constructor(readonly code: OnnxRefusalCode, message: string) {
    super(message);
  }
}

export type OnnxInspection = {
  /** The bare names of the external-data files the graph reads, sorted. */
  externalFiles: string[];
};

export type InspectOptions = {
  /** Whether `name`, a bare file name, is a file of the model next to this graph. */
  isModelFile: (name: string) => boolean;
  /** Upper bound of protobuf fields visited, against a crafted file built to stall the main process. */
  maxFields?: number;
};

/** ORT's own keys; any other one makes ORT fail, so it is refused here first. */
const EXTERNAL_KEYS = new Set(['location', 'offset', 'length', 'checksum']);
const BARE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** protobuf's own default limit; ORT keeps it. */
const MAX_DEPTH = 100;
const MAX_STRING_BYTES = 4096;
const BLOCK_BYTES = 64 * 1024;
const DATA_LOCATION_EXTERNAL = 1;

type Kind = 'model' | 'training' | 'function' | 'graph' | 'node' | 'attribute' | 'sparse' | 'tensor';

/**
 * The fields (onnx.proto, IR 10) that can hold a tensor, directly or
 * through a submessage. A field missing here cannot reach one.
 */
const CHILDREN: Readonly<Record<Exclude<Kind, 'tensor'>, Readonly<Record<number, Kind>>>> = {
  // graph, training_info, functions
  model: { 7: 'graph', 20: 'training', 25: 'function' },
  // initialization, algorithm
  training: { 1: 'graph', 3: 'graph' },
  // node, attribute_proto
  function: { 7: 'node', 11: 'attribute' },
  // node, initializer, sparse_initializer
  graph: { 1: 'node', 5: 'tensor', 15: 'sparse' },
  // attribute
  node: { 5: 'attribute' },
  // t, g, tensors, graphs, sparse_tensor, sparse_tensors
  attribute: { 5: 'tensor', 6: 'graph', 10: 'tensor', 11: 'graph', 22: 'sparse', 23: 'sparse' },
  // values, indices
  sparse: { 1: 'tensor', 2: 'tensor' },
};

const TENSOR_NAME = 8;
const TENSOR_EXTERNAL_DATA = 13;
const TENSOR_DATA_LOCATION = 14;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Positional reads through a small window: tags are tiny, payloads are skipped. */
class Reader {
  private buffer = Buffer.alloc(0);
  private bufferStart = 0;

  constructor(private readonly handle: FileHandle, readonly size: number) {}

  private async load(position: number, length: number): Promise<void> {
    if (position >= this.bufferStart && position + length <= this.bufferStart + this.buffer.length) return;
    const wanted = Math.min(Math.max(length, BLOCK_BYTES), this.size - position);
    if (wanted < length) throw new OnnxRefused('malformed', 'The graph file is truncated.');
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await this.handle.read(buffer, 0, wanted, position);
    if (bytesRead < length) throw new OnnxRefused('malformed', 'The graph file is truncated.');
    this.buffer = buffer.subarray(0, bytesRead);
    this.bufferStart = position;
  }

  /** A varint as a number; precision is lost past 2^53, which only matters for lengths and tags. */
  async varint(position: number, end: number): Promise<{ value: number; next: number }> {
    if (position >= end) throw new OnnxRefused('malformed', 'The graph file is truncated.');
    await this.load(position, Math.min(10, end - position));
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (position + i >= end) break;
      const byte = this.buffer[position + i - this.bufferStart] as number;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return { value, next: position + i + 1 };
      scale *= 128;
    }
    throw new OnnxRefused('malformed', 'The graph file holds an invalid number.');
  }

  async bytes(position: number, length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    await this.load(position, length);
    const start = position - this.bufferStart;
    return Buffer.from(this.buffer.subarray(start, start + length));
  }
}

type Field = { number: number; wire: number; start: number; end: number; varint: number; next: number };

class Walker {
  private fields = 0;
  readonly external = new Set<string>();

  constructor(private readonly reader: Reader, private readonly options: Required<InspectOptions>) {}

  /** Each field of the message in [start, end), in order. */
  private async *fieldsOf(start: number, end: number): AsyncGenerator<Field> {
    let position = start;
    while (position < end) {
      this.fields += 1;
      if (this.fields > this.options.maxFields) throw new OnnxRefused('too-complex', 'The graph file is too complex to inspect.');
      const tag = await this.reader.varint(position, end);
      if (tag.value > 0xffffffff) throw new OnnxRefused('malformed', 'The graph file holds an invalid field.');
      const number = Math.floor(tag.value / 8);
      const wire = tag.value % 8;
      if (number === 0) throw new OnnxRefused('malformed', 'The graph file holds an invalid field.');
      position = tag.next;
      switch (wire) {
        case 0: {
          const value = await this.reader.varint(position, end);
          yield { number, wire, start: position, end: value.next, varint: value.value, next: value.next };
          position = value.next;
          break;
        }
        case 1:
        case 5: {
          const next = position + (wire === 1 ? 8 : 4);
          if (next > end) throw new OnnxRefused('malformed', 'The graph file is truncated.');
          yield { number, wire, start: position, end: next, varint: 0, next };
          position = next;
          break;
        }
        case 2: {
          const length = await this.reader.varint(position, end);
          if (!Number.isSafeInteger(length.value) || length.next + length.value > end) {
            throw new OnnxRefused('malformed', 'The graph file holds a field longer than its message.');
          }
          const next = length.next + length.value;
          yield { number, wire, start: length.next, end: next, varint: 0, next };
          position = next;
          break;
        }
        default:
          // Groups (3, 4) are not used by ONNX; 6 and 7 do not exist.
          throw new OnnxRefused('malformed', 'The graph file uses an unsupported encoding.');
      }
    }
  }

  async message(kind: Kind, start: number, end: number, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new OnnxRefused('too-complex', 'The graph file nests too deeply.');
    if (kind === 'tensor') return this.tensor(start, end);
    const children = CHILDREN[kind];
    for await (const field of this.fieldsOf(start, end)) {
      const child = children[field.number];
      if (!child) continue;
      // protobuf would skip a known field sent with another wire type; a
      // graph built that way is not an export, it is refused.
      if (field.wire !== 2) throw new OnnxRefused('malformed', 'The graph file holds a field of the wrong type.');
      await this.message(child, field.start, field.end, depth + 1);
    }
  }

  private async string(field: Field): Promise<string> {
    if (field.wire !== 2) throw new OnnxRefused('malformed', 'The graph file holds a field of the wrong type.');
    if (field.end - field.start > MAX_STRING_BYTES) throw new OnnxRefused('malformed', 'The graph file holds an overlong name.');
    try {
      return utf8.decode(await this.reader.bytes(field.start, field.end - field.start));
    } catch (error) {
      if (error instanceof OnnxRefused) throw error;
      throw new OnnxRefused('malformed', 'The graph file holds a name that is not UTF-8.');
    }
  }

  /** One `StringStringEntryProto`; a key or value given twice is refused rather than resolved. */
  private async entry(start: number, end: number): Promise<{ key: string; value: string }> {
    let key: string | null = null;
    let value: string | null = null;
    for await (const field of this.fieldsOf(start, end)) {
      if (field.number !== 1 && field.number !== 2) continue;
      const text = await this.string(field);
      if (field.number === 1) {
        if (key !== null) throw new OnnxRefused('malformed', 'An external-data entry names its key twice.');
        key = text;
      } else {
        if (value !== null) throw new OnnxRefused('malformed', 'An external-data entry gives its value twice.');
        value = text;
      }
    }
    return { key: key ?? '', value: value ?? '' };
  }

  private async tensor(start: number, end: number): Promise<void> {
    let name = '';
    let dataLocation = 0;
    const locations: string[] = [];
    let entries = 0;
    for await (const field of this.fieldsOf(start, end)) {
      if (field.number === TENSOR_NAME && field.wire === 2) {
        name = await this.string(field).catch(() => '');
      } else if (field.number === TENSOR_DATA_LOCATION) {
        if (field.wire !== 0) throw new OnnxRefused('malformed', 'The graph file holds a field of the wrong type.');
        // A scalar given twice: the last one wins, as in protobuf.
        dataLocation = field.varint;
      } else if (field.number === TENSOR_EXTERNAL_DATA) {
        if (field.wire !== 2) throw new OnnxRefused('malformed', 'The graph file holds a field of the wrong type.');
        entries += 1;
        const { key, value } = await this.entry(field.start, field.end);
        if (!EXTERNAL_KEYS.has(key)) {
          throw new OnnxRefused('external-unknown-key', `Tensor ${display(name)} has an unknown external-data key.`);
        }
        if (key === 'location') locations.push(value);
      }
    }
    // Entries without EXTERNAL are ignored by ORT today; checked anyway, a later version may not ignore them.
    if (dataLocation === DATA_LOCATION_EXTERNAL && locations.length !== 1) {
      throw new OnnxRefused('external-outside', `Tensor ${display(name)} reads external data without exactly one location.`);
    }
    if (entries > 0 && locations.length > 1) {
      throw new OnnxRefused('external-outside', `Tensor ${display(name)} names several external-data locations.`);
    }
    for (const location of locations) {
      if (!BARE_NAME.test(location) || location === '.' || location === '..' || !this.options.isModelFile(location)) {
        throw new OnnxRefused('external-outside', `Tensor ${display(name)} reads data outside the model folder.`);
      }
      this.external.add(location);
    }
  }
}

/** Tensor names come from the file: shortened and stripped before reaching a message. */
function display(name: string): string {
  const clean = name.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
  return clean ? `"${clean}"` : '(unnamed)';
}

/**
 * Inspects the ONNX graph at `file`. Throws `OnnxRefused` for a graph that
 * reads data outside its folder or that cannot be read as protobuf.
 */
export async function inspectOnnx(file: string, options: InspectOptions): Promise<OnnxInspection> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new OnnxRefused('malformed', 'The graph is not a regular file.');
    const walker = new Walker(new Reader(handle, info.size), { maxFields: 50_000_000, ...options });
    await walker.message('model', 0, info.size, 0);
    return { externalFiles: [...walker.external].sort() };
  } finally {
    await handle.close();
  }
}

export type ModelInspection = { ok: true; externalFiles: string[] } | { ok: false; message: string };

/**
 * Inspects every `.onnx` of `model` in `dir`: a graph may only read external
 * data from a file of the same model, in its own folder. `externalFiles`
 * lists the paths those graphs read. Every file of the model must be a
 * regular file, not a link: the addon would follow one wherever it points.
 */
export async function inspectModelGraphs(model: SpeechModel, dir: string): Promise<ModelInspection> {
  for (const file of model.files) {
    const info = await lstat(join(dir, ...pathSegments(file))).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile()) return { ok: false, message: `${file.path} is not a regular file of the model.` };
  }
  const external = new Set<string>();
  for (const file of model.files) {
    if (!file.path.toLowerCase().endsWith('.onnx')) continue;
    const segments = pathSegments(file);
    const folder = segments.slice(0, -1).join('/');
    const siblings = new Set(model.files
      .map((other) => pathSegments(other))
      .filter((other) => other.slice(0, -1).join('/') === folder)
      .map((other) => other.at(-1) ?? ''));
    try {
      const result = await inspectOnnx(join(dir, ...segments), { isModelFile: (name) => siblings.has(name) });
      for (const name of result.externalFiles) external.add(folder ? `${folder}/${name}` : name);
    } catch (error) {
      if (error instanceof OnnxRefused) return { ok: false, message: `${file.path}: ${error.message}` };
      return { ok: false, message: `${file.path} could not be read.` };
    }
  }
  return { ok: true, externalFiles: [...external].sort() };
}
