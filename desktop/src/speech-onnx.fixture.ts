/**
 * Minimal ONNX graphs written as raw protobuf, for the inspector and import
 * tests (TODO #484). Field numbers follow onnx.proto; nothing here is a
 * runnable model, only what the inspector reads.
 */

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

export function bytesField(number: number, payload: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]);
}

export function stringField(number: number, text: string): Buffer {
  return bytesField(number, Buffer.from(text, 'utf8'));
}

export function intField(number: number, value: number): Buffer {
  return Buffer.concat([varint(number * 8), varint(value)]);
}

export function entry(key: string, value: string): Buffer {
  return Buffer.concat([stringField(1, key), stringField(2, value)]);
}

export type TensorSpec = {
  name?: string;
  /** Sets `data_location = EXTERNAL` with this `location`. */
  location?: string;
  entries?: Buffer[];
  dataLocation?: number;
  rawBytes?: number;
};

export function tensor(spec: TensorSpec = {}): Buffer {
  const parts = [intField(1, 4), intField(2, 1), stringField(8, spec.name ?? 'weight')];
  if (spec.rawBytes) parts.push(bytesField(9, Buffer.alloc(spec.rawBytes, 7)));
  if (spec.location !== undefined) {
    parts.push(bytesField(13, entry('location', spec.location)));
    parts.push(bytesField(13, entry('offset', '0')));
    parts.push(bytesField(13, entry('length', '16')));
  }
  for (const extra of spec.entries ?? []) parts.push(bytesField(13, extra));
  const location = spec.dataLocation ?? (spec.location !== undefined ? 1 : undefined);
  if (location !== undefined) parts.push(intField(14, location));
  return Buffer.concat(parts);
}

/** A node whose attribute `value` holds `t` (a Constant), or `g` when given a graph. */
export function node(attribute: { tensor?: Buffer; graph?: Buffer }): Buffer {
  const attr = [stringField(1, 'value')];
  if (attribute.tensor) attr.push(bytesField(5, attribute.tensor));
  if (attribute.graph) attr.push(bytesField(6, attribute.graph));
  return Buffer.concat([stringField(2, 'out'), stringField(4, attribute.graph ? 'If' : 'Constant'), bytesField(5, Buffer.concat(attr))]);
}

export function graph(parts: { initializers?: Buffer[]; nodes?: Buffer[]; sparse?: Buffer[] } = {}): Buffer {
  return Buffer.concat([
    ...(parts.nodes ?? []).map((n) => bytesField(1, n)),
    stringField(2, 'main'),
    ...(parts.initializers ?? []).map((t) => bytesField(5, t)),
    ...(parts.sparse ?? []).map((s) => bytesField(15, s)),
  ]);
}

export function model(mainGraph: Buffer, extra: Buffer[] = []): Buffer {
  return Buffer.concat([intField(1, 10), stringField(2, 'timon-test'), bytesField(7, mainGraph), ...extra]);
}

/** The data file name of Cohere's export: as long as `../../../../etc/passwd`. */
export const DATA_NAME = 'encoder.int8.onnx.data';
export const PASSWD_ESCAPE = '../../../../etc/passwd';

/** A graph whose one initializer lives in `DATA_NAME`, like Cohere's int8 encoder. */
export function externalDataModel(): Buffer {
  return model(graph({ initializers: [tensor({ name: 'encoder.weight', location: DATA_NAME })] }));
}

/**
 * Replaces `from` by `to` in the raw bytes, as a hex editor would: same
 * length, so every protobuf length around it stays valid.
 */
export function patchBytes(bytes: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('a binary patch keeps the length');
  const at = bytes.indexOf(Buffer.from(from, 'utf8'));
  if (at < 0) throw new Error(`"${from}" is not in the graph`);
  const patched = Buffer.from(bytes);
  patched.write(to, at, 'utf8');
  return patched;
}
