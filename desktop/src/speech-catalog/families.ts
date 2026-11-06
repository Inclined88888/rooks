/**
 * The sherpa-onnx recognizer families the desktop knows how to run (TODO #484).
 *
 * A catalog entry names its family; this table, in code, decides everything
 * the addon will see: which file roles the family needs, the config key the
 * worker builds, which language parameters exist and which options a catalog
 * entry may set. Data never chooses an addon key: an entry from a plugin newer
 * than this desktop, with a family missing here, is refused, never executed.
 */

export const MODEL_FAMILIES = ['nemo-transducer', 'nemo-canary', 'whisper', 'cohere-transcribe'] as const;
export type ModelFamily = typeof MODEL_FAMILIES[number];

/**
 * `data` is an external-data file a graph names by itself (Cohere's
 * `encoder.int8.onnx.data`): it can appear several times and is never
 * renamed, since the name is written inside the `.onnx`. Any family may
 * carry one: external data is a property of the ONNX export, not of the
 * recognizer (a local import of a large fp32 transducer uses it too).
 */
export const FILE_ROLES = ['encoder', 'decoder', 'joiner', 'tokens', 'data'] as const;
export type FileRole = typeof FILE_ROLES[number];

/**
 * `auto`: the model detects the language. `forced`: the language is imposed
 * at load, the product keeps an Auto choice by falling back on an `auto`
 * model. `required`: no Auto at all for this model.
 */
export const LANGUAGE_MODES = ['auto', 'forced', 'required'] as const;
export type LanguageMode = typeof LANGUAGE_MODES[number];

export type OptionType = 'boolean' | 'number';

export type FamilySpec = {
  /** The `modelConfig` key of the addon (`createOfflineRecognizer`). */
  configKey: 'transducer' | 'canary' | 'whisper' | 'cohereTranscribe';
  requiredRoles: readonly FileRole[];
  optionalRoles: readonly FileRole[];
  /** The addon parameters that receive the imposed language; empty when it has none. */
  languageParams: readonly string[];
  /** The codes the addon accepts in those parameters; empty when it has none. */
  languages: readonly string[];
  languageModes: readonly LanguageMode[];
  /** Options an entry may set, by name; anything else is refused. */
  options: Readonly<Record<string, OptionType>>;
};

/** The language tokens of the Whisper tokenizer (large-v3, `yue` included). */
const WHISPER_LANGUAGES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
  'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
  'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
] as const;

export const FAMILIES: Readonly<Record<ModelFamily, FamilySpec>> = {
  'nemo-transducer': {
    configKey: 'transducer',
    requiredRoles: ['encoder', 'decoder', 'joiner', 'tokens'],
    optionalRoles: ['data'],
    languageParams: [],
    languages: [],
    languageModes: ['auto'],
    options: {},
  },
  'nemo-canary': {
    configKey: 'canary',
    requiredRoles: ['encoder', 'decoder', 'tokens'],
    optionalRoles: ['data'],
    // Canary transcribes when the target language equals the source one.
    languageParams: ['srcLang', 'tgtLang'],
    languages: ['en', 'es', 'de', 'fr'],
    languageModes: ['forced'],
    options: { usePnc: 'boolean' },
  },
  whisper: {
    configKey: 'whisper',
    requiredRoles: ['encoder', 'decoder', 'tokens'],
    optionalRoles: ['data'],
    languageParams: ['language'],
    languages: WHISPER_LANGUAGES,
    languageModes: ['auto', 'forced'],
    options: { tailPaddings: 'number' },
  },
  'cohere-transcribe': {
    configKey: 'cohereTranscribe',
    requiredRoles: ['encoder', 'decoder', 'tokens'],
    optionalRoles: ['data'],
    // Without it the addon fails: "Please specify a language for Cohere Transcribe".
    languageParams: ['language'],
    languages: ['ar', 'de', 'el', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'vi', 'zh'],
    languageModes: ['required'],
    options: { usePunct: 'boolean', useItn: 'boolean' },
  },
};

/** Roles that may appear more than once in an entry. */
export const REPEATABLE_ROLES: readonly FileRole[] = ['data'];

export function isKnownFamily(value: unknown): value is ModelFamily {
  return typeof value === 'string' && (MODEL_FAMILIES as readonly string[]).includes(value);
}

/**
 * Every language a family can impose, sorted: the closed list the worker
 * protocol accepts. Nothing else ever reaches an addon language parameter.
 */
export const SPEECH_LANGUAGES = [...new Set(MODEL_FAMILIES.flatMap((family) => FAMILIES[family].languages))].sort() as [string, ...string[]];

/** Whether `family` cannot run without an imposed language (Canary, Cohere). */
export function needsLanguage(family: ModelFamily): boolean {
  const spec = FAMILIES[family];
  return spec.languageParams.length > 0 && !spec.languageModes.includes('auto');
}
