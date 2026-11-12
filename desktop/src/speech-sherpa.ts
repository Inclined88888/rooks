import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { WorkerFileRole, WorkerInit } from './speech-protocol.js';
import type { Recognizer } from './speech-session.js';

/** The part of the sherpa-onnx N-API addon this file uses. It ships no types. */
type SherpaAddon = {
  createOfflineRecognizer(config: unknown): object;
  createOfflineStream(recognizer: object): object;
  acceptWaveformOffline(stream: object, wave: { sampleRate: number; samples: Float32Array }): void;
  decodeOfflineStream(recognizer: object, stream: object): void;
  getOfflineStreamResultAsJson(stream: object): string;
};

type Option = WorkerInit['options'][string] | undefined;

/** The addon reads its switches as int32: 1 or 0, never a boolean. */
function flag(value: Option, fallback: boolean): 0 | 1 {
  if (value === undefined) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

function language(init: WorkerInit): string {
  // The protocol already refuses this; a recognizer never loads without its language.
  if (!init.language) throw new Error(`the ${init.family} family needs a language`);
  return init.language;
}

/**
 * The `modelConfig` of the addon for one family (TODO #484). Every key is
 * written here, by the family's code; the init only brings values: paths
 * under the model folder, an imposed language, the options the family allows.
 * An option this code does not read is never forwarded.
 */
export function familyModelConfig(init: WorkerInit): Record<string, unknown> {
  const path = (role: WorkerFileRole): string => {
    const relative = init.files[role];
    if (!relative) throw new Error(`the ${init.family} family needs a "${role}" file`);
    return join(init.modelDir, ...relative.split('/'));
  };
  switch (init.family) {
    case 'nemo-transducer':
      return { transducer: { encoder: path('encoder'), decoder: path('decoder'), joiner: path('joiner') } };
    case 'nemo-canary': {
      const lang = language(init);
      // Canary transcribes when the target language is the source one; otherwise it translates.
      return { canary: { encoder: path('encoder'), decoder: path('decoder'), srcLang: lang, tgtLang: lang, usePnc: flag(init.options.usePnc, true) } };
    }
    case 'whisper': {
      const padding = init.options.tailPaddings;
      return {
        whisper: {
          encoder: path('encoder'),
          decoder: path('decoder'),
          // Empty: the multilingual model detects the language.
          language: init.language ?? '',
          task: 'transcribe',
          tailPaddings: typeof padding === 'number' ? Math.max(-1, Math.min(1000, Math.trunc(padding))) : -1,
        },
      };
    }
    case 'cohere-transcribe':
      return {
        cohereTranscribe: {
          encoder: path('encoder'),
          decoder: path('decoder'),
          language: language(init),
          usePunct: flag(init.options.usePunct, true),
          useItn: flag(init.options.useItn, true),
        },
      };
    default: {
      const unknown: never = init.family;
      throw new Error(`unknown speech model family ${String(unknown)}`);
    }
  }
}

/** The whole `createOfflineRecognizer` config; pure, so tests read it without the addon. */
export function recognizerConfig(init: WorkerInit): Record<string, unknown> {
  const tokens = init.files.tokens;
  return {
    // NeMo and Cohere models read their real feature size from their metadata.
    featConfig: { sampleRate: init.sampleRate, featureDim: 80 },
    modelConfig: {
      ...familyModelConfig(init),
      tokens: tokens ? join(init.modelDir, ...tokens.split('/')) : '',
      numThreads: init.numThreads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  };
}

/**
 * A `Recognizer` over the native sherpa-onnx addon, loaded by path: the
 * per-OS package is resolved by the main process (`sherpaAddonDir`), never
 * through the `sherpa-onnx` WASM package, which cannot read model files.
 */
export function sherpaRecognizer(init: WorkerInit): Recognizer {
  const sherpa = createRequire(import.meta.url)(init.addonDir) as SherpaAddon;
  const recognizer = sherpa.createOfflineRecognizer(recognizerConfig(init));
  return {
    decode(samples) {
      // An offline stream is single-use: one per utterance.
      const stream = sherpa.createOfflineStream(recognizer);
      sherpa.acceptWaveformOffline(stream, { sampleRate: init.sampleRate, samples });
      sherpa.decodeOfflineStream(recognizer, stream);
      const result: unknown = JSON.parse(sherpa.getOfflineStreamResultAsJson(stream));
      const text = result && typeof result === 'object' ? (result as { text?: unknown }).text : undefined;
      return typeof text === 'string' ? text.trim() : '';
    },
  };
}
