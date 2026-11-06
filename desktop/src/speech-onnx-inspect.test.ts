import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectOnnx, OnnxRefused, type OnnxRefusalCode } from './speech-onnx-inspect.js';
import {
  bytesField, DATA_NAME, entry, externalDataModel, graph, intField, model, node, PASSWD_ESCAPE, patchBytes, stringField, tensor,
} from './speech-onnx.fixture.js';

function write(bytes: Buffer): string {
  const file = join(mkdtempSync(join(tmpdir(), 'onnx-')), 'encoder.int8.onnx');
  writeFileSync(file, bytes);
  return file;
}

const modelFiles = new Set([DATA_NAME, 'decoder.int8.onnx', 'tokens.txt']);
const isModelFile = (name: string): boolean => modelFiles.has(name);

async function refused(bytes: Buffer, code: OnnxRefusalCode, options: { maxFields?: number } = {}): Promise<void> {
  await assert.rejects(inspectOnnx(write(bytes), { isModelFile, ...options }), (error: unknown) => {
    assert.ok(error instanceof OnnxRefused, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

// Refusals first (AGENTS.md rule 8).

test('the measured attack: a graph patched to read ../../../../etc/passwd is refused', async () => {
  const legit = externalDataModel();
  const patched = patchBytes(legit, DATA_NAME, PASSWD_ESCAPE);
  assert.equal(patched.length, legit.length);
  await refused(patched, 'external-outside');
});

test('every location that is not a bare name of the model is refused', async () => {
  for (const location of [
    '/etc/passwd', '..', '.', 'sub/encoder.data', 'sub\\encoder.data', 'C:\\Windows\\win.ini', 'C:encoder.data',
    '*/_ORT_MEM_ADDR_/*', '', 'other.data', 'Encoder.int8.onnx.data', `${DATA_NAME} `, 'x'.repeat(101),
  ]) {
    await refused(model(graph({ initializers: [tensor({ location })] })), 'external-outside');
  }
});

test('an external tensor hidden in a constant, a subgraph, a sparse initializer, a function or a training graph is found', async () => {
  const bad = tensor({ location: PASSWD_ESCAPE });
  const sparse = Buffer.concat([bytesField(1, bad), bytesField(2, tensor())]);
  const cases: Buffer[] = [
    model(graph({ nodes: [node({ tensor: bad })] })),
    model(graph({ nodes: [node({ graph: graph({ nodes: [node({ graph: graph({ initializers: [bad] }) })] }) })] })),
    model(graph({ sparse: [sparse] })),
    // FunctionProto.node (7) holding a Constant.
    model(graph(), [bytesField(25, Buffer.concat([stringField(1, 'f'), bytesField(7, node({ tensor: bad }))]))]),
    // TrainingInfoProto.algorithm (3).
    model(graph(), [bytesField(20, bytesField(3, graph({ initializers: [bad] })))]),
    // A second `graph` field: protobuf merges it into the first one.
    model(graph(), [bytesField(7, graph({ initializers: [bad] }))]),
    // AttributeProto.tensors (10) and graphs (11).
    model(graph({ nodes: [Buffer.concat([stringField(4, 'Loop'), bytesField(5, Buffer.concat([stringField(1, 'body'), bytesField(10, bad)]))])] })),
    model(graph({ nodes: [Buffer.concat([stringField(4, 'Loop'), bytesField(5, Buffer.concat([stringField(1, 'body'), bytesField(11, graph({ initializers: [bad] }))]))])] })),
  ];
  for (const [index, bytes] of cases.entries()) {
    await assert.rejects(inspectOnnx(write(bytes), { isModelFile }), OnnxRefused, `case ${index}`);
  }
});

test('an EXTERNAL tensor without exactly one location, or with a key ORT does not know, is refused', async () => {
  await refused(model(graph({ initializers: [tensor({ dataLocation: 1 })] })), 'external-outside');
  await refused(model(graph({ initializers: [tensor({ location: DATA_NAME, entries: [entry('location', DATA_NAME)] })] })), 'external-outside');
  await refused(model(graph({ initializers: [tensor({ location: DATA_NAME, entries: [entry('basepath', '/etc')] })] })), 'external-unknown-key');
  // Entries are checked even without data_location = EXTERNAL.
  await refused(model(graph({ initializers: [tensor({ entries: [entry('location', PASSWD_ESCAPE)] })] })), 'external-outside');
});

test('an entry that gives its key or its value twice is refused, not resolved as protobuf would', async () => {
  const twiceKey = Buffer.concat([stringField(1, 'offset'), stringField(2, PASSWD_ESCAPE), stringField(1, 'location')]);
  const twiceValue = Buffer.concat([stringField(1, 'location'), stringField(2, DATA_NAME), stringField(2, PASSWD_ESCAPE)]);
  for (const bad of [twiceKey, twiceValue]) {
    await refused(model(graph({ initializers: [tensor({ entries: [bad], dataLocation: 1 })] })), 'malformed');
  }
});

test('a file that is not a readable protobuf is refused', async () => {
  const valid = externalDataModel();
  await refused(valid.subarray(0, valid.length - 3), 'malformed');
  // A length running past the end of the file.
  await refused(Buffer.concat([intField(1, 10), Buffer.from([7 * 8 + 2, 0xff, 0xff, 0x03])]), 'malformed');
  // Field number 0, a group wire type, an unterminated varint.
  await refused(Buffer.from([0x02, 0x00]), 'malformed');
  await refused(Buffer.from([7 * 8 + 3]), 'malformed');
  await refused(Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), 'malformed');
  // `graph` sent as a varint: protobuf would skip it, so would hide a tensor from a lenient reader.
  await refused(Buffer.from([7 * 8, 0x01]), 'malformed');
  await refused(Buffer.from('this is not an onnx graph', 'utf8'), 'malformed');
});

test('a graph nested past the protobuf depth limit, or with too many fields, is refused', async () => {
  let deep = graph({ initializers: [tensor()] });
  for (let i = 0; i < 40; i += 1) deep = graph({ nodes: [node({ graph: deep })] });
  await refused(model(deep), 'too-complex');
  await refused(model(graph({ initializers: Array.from({ length: 50 }, () => tensor()) })), 'too-complex', { maxFields: 100 });
});

// Then what passes.

test('a graph with external data in a file of the model passes and names that file', async () => {
  const result = await inspectOnnx(write(externalDataModel()), { isModelFile });
  assert.deepEqual(result.externalFiles, [DATA_NAME]);
});

test('a self-contained graph passes with no external file, its payloads skipped', async () => {
  const bytes = model(graph({
    nodes: [node({ tensor: tensor({ name: 'c' }) })],
    initializers: [tensor({ name: 'big', rawBytes: 300_000 }), tensor({ name: 'neg' })],
  }), [intField(5, 2 ** 40)]);
  const result = await inspectOnnx(write(bytes), { isModelFile: () => false });
  assert.deepEqual(result.externalFiles, []);
});
