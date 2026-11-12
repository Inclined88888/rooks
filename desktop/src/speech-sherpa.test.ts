import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FAMILIES, MODEL_FAMILIES } from './speech-catalog/families.js';
import { workerInitSchema, type WorkerInit } from './speech-protocol.js';
import { familyModelConfig, recognizerConfig } from './speech-sherpa.js';

const DIR = join('models', 'some-model');

function init(overrides: Partial<WorkerInit>): WorkerInit {
  return workerInitSchema.parse({
    type: 'init', addonDir: 'addon', modelDir: DIR, sampleRate: 16_000, numThreads: 2,
    family: 'nemo-transducer', language: null, options: {}, filter: 'nemo',
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
    ...overrides,
  });
}

const canary = (overrides: Partial<WorkerInit> = {}): WorkerInit => init({
  family: 'nemo-canary', language: 'fr', filter: 'nemo',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' },
  ...overrides,
});

const cohere = (overrides: Partial<WorkerInit> = {}): WorkerInit => init({
  family: 'cohere-transcribe', language: 'fr', filter: 'cohere',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' },
  ...overrides,
});

test('a family never runs without the language it cannot detect', () => {
  // The protocol refuses it first; the config builder refuses it again.
  assert.throws(() => familyModelConfig({ ...canary(), language: null }), /needs a language/);
  assert.throws(() => familyModelConfig({ ...cohere(), language: null }), /needs a language/);
  assert.throws(() => familyModelConfig({ ...canary(), files: { encoder: 'e.onnx', tokens: 't.txt' } }), /needs a "decoder"/);
});

test('options a family does not read are never forwarded to the addon', () => {
  // Bypass the protocol on purpose: even a forged init cannot add an addon key.
  const forged = { ...canary(), options: { usePnc: true, modelType: 'whisper', encoder: '/etc/passwd' } } as WorkerInit;
  assert.deepEqual(Object.keys(familyModelConfig(forged).canary as object).sort(), ['decoder', 'encoder', 'srcLang', 'tgtLang', 'usePnc']);
  const config = recognizerConfig(forged);
  assert.deepEqual(Object.keys(config.modelConfig as object).sort(), ['canary', 'debug', 'numThreads', 'provider', 'tokens']);
});

test('each family writes its own addon key, the one of the family table', () => {
  const samples: Record<typeof MODEL_FAMILIES[number], WorkerInit> = {
    'nemo-transducer': init({}),
    'nemo-canary': canary(),
    whisper: init({ family: 'whisper', files: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', tokens: 'tokens.txt' } }),
    'cohere-transcribe': cohere(),
  };
  for (const family of MODEL_FAMILIES) {
    assert.deepEqual(Object.keys(familyModelConfig(samples[family])), [FAMILIES[family].configKey], family);
  }
});

test('the transducer config is the one Parakeet always had', () => {
  assert.deepEqual(recognizerConfig(init({})), {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: join(DIR, 'encoder.int8.onnx'), decoder: join(DIR, 'decoder.int8.onnx'), joiner: join(DIR, 'joiner.int8.onnx') },
      tokens: join(DIR, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
});

test('Canary transcribes: the target language is the source one, punctuation on by default', () => {
  assert.deepEqual(familyModelConfig(canary()), {
    canary: { encoder: join(DIR, 'encoder.int8.onnx'), decoder: join(DIR, 'decoder.int8.onnx'), srcLang: 'fr', tgtLang: 'fr', usePnc: 1 },
  });
  assert.equal((familyModelConfig(canary({ options: { usePnc: false } })).canary as { usePnc: number }).usePnc, 0);
});

test('Cohere gets its language, punctuation and ITN as int32 switches', () => {
  assert.deepEqual(familyModelConfig(cohere({ language: 'de' })), {
    cohereTranscribe: { encoder: join(DIR, 'encoder.int8.onnx'), decoder: join(DIR, 'decoder.int8.onnx'), language: 'de', usePunct: 1, useItn: 1 },
  });
  const plain = familyModelConfig(cohere({ options: { usePunct: false, useItn: false } })).cohereTranscribe as Record<string, unknown>;
  assert.equal(plain.usePunct, 0);
  assert.equal(plain.useItn, 0);
});

test('Whisper detects the language when none is imposed, and its padding is bounded', () => {
  const files = { encoder: 'encoder.onnx', decoder: 'decoder.onnx', tokens: 'tokens.txt' };
  const auto = familyModelConfig(init({ family: 'whisper', files })).whisper as Record<string, unknown>;
  assert.equal(auto.language, '');
  assert.equal(auto.task, 'transcribe');
  assert.equal(auto.tailPaddings, -1);
  const forced = familyModelConfig(init({ family: 'whisper', files, language: 'tr', options: { tailPaddings: 1e9 } })).whisper as Record<string, unknown>;
  assert.equal(forced.language, 'tr');
  assert.equal(forced.tailPaddings, 1000);
});

test('a file one folder down is joined segment by segment under the model folder', () => {
  const config = recognizerConfig(canary({ files: { encoder: 'onnx/encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokenizer/tokens.txt' } }));
  const model = config.modelConfig as { canary: { encoder: string }; tokens: string };
  assert.equal(model.canary.encoder, join(DIR, 'onnx', 'encoder.int8.onnx'));
  assert.equal(model.tokens, join(DIR, 'tokenizer', 'tokens.txt'));
});
