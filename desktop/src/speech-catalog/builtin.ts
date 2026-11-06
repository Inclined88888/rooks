import { speechCatalogSchema, type SpeechModel, type SpeechModelInput } from './schema.js';

/**
 * The speech models shipped with the desktop (TODO #443, #484).
 *
 * Sizes and sha256 read on 27/10/2026 from the Hugging Face tree API at the
 * pinned revision (LFS `oid`) and, for the non-LFS `tokens.txt`, from the
 * file itself after checking its git blob id against the tree. Memory and
 * languages come from the measures of the vault notes `dictee-locale-langue`
 * and `dictee-moteurs-plugins` (TODO #482, #484).
 */

/** The 25 European languages of Parakeet TDT v3 (model card). */
const PARAKEET_LANGUAGES = [
  'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it',
  'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
];

const PARAKEET_TDT_V3_INT8_ENTRY: SpeechModelInput = {
  schema: 1,
  id: 'parakeet-tdt-0.6b-v3-int8',
  label: 'Parakeet TDT v3 (25 European languages)',
  family: 'nemo-transducer',
  source: {
    kind: 'huggingface',
    repository: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    revision: '2bda32ec70b097a55adaa07d9a7173915b43cc78',
  },
  files: [
    { role: 'encoder', path: 'encoder.int8.onnx', sizeBytes: 652_184_281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
    { role: 'decoder', path: 'decoder.int8.onnx', sizeBytes: 11_845_275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
    { role: 'joiner', path: 'joiner.int8.onnx', sizeBytes: 6_355_277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
    { role: 'tokens', path: 'tokens.txt', sizeBytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  ],
  memory: { ramBytes: 1_460_000_000, peakRamBytes: 1_600_000_000 },
  languages: { codes: PARAKEET_LANGUAGES, mode: 'auto' },
  // Under 2 s it may hear English in any language (TODO #482): no early partial.
  interim: { mode: 'live', minUtteranceMs: 2000 },
  filter: 'nemo',
  license: {
    spdx: 'CC-BY-4.0',
    attribution: 'NVIDIA, Parakeet TDT 0.6B v3',
    url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
    redistribution: 'ok',
  },
  requires: { addon: '>=1.12.37' },
};

const CANARY_180M_FLASH_INT8_ENTRY: SpeechModelInput = {
  schema: 1,
  id: 'canary-180m-flash-int8',
  label: 'Canary 180M Flash (English, Spanish, German, French)',
  family: 'nemo-canary',
  source: {
    kind: 'huggingface',
    repository: 'csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8',
    revision: '9077164e0d3dd1d5353743e89ceaa1d3a770838c',
  },
  files: [
    { role: 'encoder', path: 'encoder.int8.onnx', sizeBytes: 132_678_643, sha256: '7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f' },
    { role: 'decoder', path: 'decoder.int8.onnx', sizeBytes: 74_437_848, sha256: 'e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2' },
    { role: 'tokens', path: 'tokens.txt', sizeBytes: 53_555, sha256: '2dae6fc7815f9640645e0c765522b278ee0cef49b482d91f6913e334628d3e77' },
  ],
  memory: { ramBytes: 340_000_000, peakRamBytes: 630_000_000 },
  languages: { codes: ['en', 'es', 'de', 'fr'], mode: 'forced' },
  interim: { mode: 'live', minUtteranceMs: 1500 },
  filter: 'nemo',
  options: { usePnc: true },
  license: {
    spdx: 'CC-BY-4.0',
    attribution: 'NVIDIA, Canary 180M Flash',
    url: 'https://huggingface.co/nvidia/canary-180m-flash',
    redistribution: 'ok',
  },
  requires: { addon: '>=1.12.37' },
};

/** The 14 languages of Cohere Transcribe 03-2026 (model card); none is detected. */
const COHERE_LANGUAGES = ['ar', 'de', 'el', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'vi', 'zh'];

/**
 * The precise option (TODO #484, E1): the best French WER measured (7.2 %
 * against 10.1 % for Parakeet), but 2.9 GB, 3.6 GB of memory at peak, no
 * Auto, and credits invented on silence. Never a default (`required`); the
 * user downloads it on purpose. Source: the sherpa-onnx export of the
 * Apache-2.0 upstream, which is gated on Hugging Face and cannot be fetched
 * anonymously; the mirror shows no licence of its own, the upstream's applies.
 */
const COHERE_TRANSCRIBE_INT8_ENTRY: SpeechModelInput = {
  schema: 1,
  id: 'cohere-transcribe-03-2026-int8',
  label: 'Cohere Transcribe 03-2026 (14 languages)',
  tier: 'precise',
  family: 'cohere-transcribe',
  source: {
    kind: 'huggingface',
    repository: 'csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01',
    revision: '156a470cf08eefe706a0004f3c52d9ee567ca7a0',
  },
  files: [
    { role: 'encoder', path: 'encoder.int8.onnx', sizeBytes: 3_090_822, sha256: 'cf704f8cfa90e3f0a76f9ffc05998bdf00ba9ae983192c14a85a3a5eb008b367' },
    // The graph names this file itself: it is downloaded under this exact name, never renamed.
    { role: 'data', path: 'encoder.int8.onnx.data', sizeBytes: 2_731_503_072, sha256: 'bcf1b7148c8518ae52df1ad2d2fc2b4e89261ea23e6c874eef1d9f55bcbaa4a3' },
    { role: 'decoder', path: 'decoder.int8.onnx', sizeBytes: 153_250_705, sha256: '8372ca6c8ff4db8b916ca3592f5c757a715e691b9edec751ba19b29fc854baf9' },
    { role: 'tokens', path: 'tokens.txt', sizeBytes: 207_437, sha256: '013ede043ae2480e3a9205cc34550d9686100cc682bacc90f702facdfbb93035' },
  ],
  memory: { ramBytes: 2_060_000_000, peakRamBytes: 3_600_000_000 },
  languages: { codes: COHERE_LANGUAGES, mode: 'required' },
  // 1 to 2 s per decode, and it cuts words on fragments: no provisional text.
  interim: { mode: 'final-only' },
  filter: 'cohere',
  options: { usePunct: true, useItn: true },
  license: {
    spdx: 'Apache-2.0',
    attribution: 'Cohere Labs, Cohere Transcribe 03-2026 (sherpa-onnx int8 export)',
    url: 'https://huggingface.co/CohereLabs/cohere-transcribe-03-2026',
    redistribution: 'ok',
  },
  requires: { addon: '>=1.12.37' },
};

/** Parsed once, when the module loads: a malformed built-in entry fails at once, in tests first. */
export const BUILTIN_SPEECH_MODELS: readonly SpeechModel[] = Object.freeze(
  speechCatalogSchema.parse([PARAKEET_TDT_V3_INT8_ENTRY, CANARY_180M_FLASH_INT8_ENTRY, COHERE_TRANSCRIBE_INT8_ENTRY]),
);

function builtin(id: string): SpeechModel {
  const model = BUILTIN_SPEECH_MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`Missing built-in speech model ${id}.`);
  return model;
}

export const PARAKEET_TDT_V3_INT8 = builtin(PARAKEET_TDT_V3_INT8_ENTRY.id);
export const CANARY_180M_FLASH_INT8 = builtin(CANARY_180M_FLASH_INT8_ENTRY.id);
export const COHERE_TRANSCRIBE_INT8 = builtin(COHERE_TRANSCRIBE_INT8_ENTRY.id);

/** The model the desktop offers before any language was chosen: it detects the language. */
export const DEFAULT_SPEECH_MODEL_ID = PARAKEET_TDT_V3_INT8.id;

export function speechModel(id: string, catalog: readonly SpeechModel[] = BUILTIN_SPEECH_MODELS): SpeechModel | null {
  return catalog.find((model) => model.id === id) ?? null;
}

/** `fr-FR`, `FR`, `fr_fr` → `fr`; `auto`, empty or malformed → null (Auto). */
export function primaryLanguage(lang: string | null | undefined): string | null {
  const primary = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

export type ResolvedModel = {
  model: SpeechModel;
  /** The language to impose at load, or null when the model detects it. */
  language: string | null;
};

export type ResolveOptions = {
  catalog?: readonly SpeechModel[];
  /** Only these models may be picked (installed ones, say); all when absent. */
  usable?: (model: SpeechModel) => boolean;
};

/**
 * The model to dictate in `lang` (`auto`, `fr`, `fr-FR`…).
 *
 * A model that imposes the language wins over one that detects it: the
 * language then never flips to English on a short fragment (TODO #482).
 * Among equals, catalog order decides. A `required` model (no Auto, final
 * text only) is never a default: the user picks it on purpose. Auto, or a
 * language no forced model knows, falls back on the first model that detects
 * the language. Null when nothing usable fits.
 */
export function resolveModel(lang: string | null | undefined, options: ResolveOptions = {}): ResolvedModel | null {
  const catalog = options.catalog ?? BUILTIN_SPEECH_MODELS;
  const usable = options.usable ?? (() => true);
  const language = primaryLanguage(lang);
  if (language) {
    const forced = catalog.find((model) => (
      model.languages.mode === 'forced' && model.languages.codes.includes(language) && usable(model)
    ));
    if (forced) return { model: forced, language };
    const detecting = catalog.find((model) => (
      model.languages.mode === 'auto' && model.languages.codes.includes(language) && usable(model)
    ));
    if (detecting) return { model: detecting, language: null };
  }
  const fallback = catalog.find((model) => model.languages.mode === 'auto' && usable(model));
  return fallback ? { model: fallback, language: null } : null;
}
