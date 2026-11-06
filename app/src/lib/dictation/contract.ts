/**
 * The dictation engine contract (client API 14, TODO #484), as the browser
 * half of the product reads it.
 *
 * The types mirror `@timon-ai/sdk` (`packages/sdk/src/index.ts`) instead of
 * importing it: the app is built on its own (its Docker context is `app/`),
 * like `WidgetOptions` in `plugin-host/slots.ts`. Their shapes are frozen on
 * the SDK side by `orchestrator/src/plugins/contract-surface.json`
 * (`dictationTypes`), and these copies held to them by
 * `app/sdk-guards/sdk-mirrors.ts` (`plugin-host/sdk-mirrors.test.ts`).
 *
 * An engine is code from a plugin and a source of untrusted text: everything
 * it hands back goes through a guard below before it reaches a draft, and a
 * value that fails one is dropped, never repaired.
 */

export const DICTATION_ENGINE_SLOT = 'dictation.engine';

/** What `DictationSession.feed` receives: 16 kHz mono Float32, 1 sample to 2 s per call. */
export const DICTATION_SAMPLE_RATE = 16_000;
export const MAX_FEED_SAMPLES = DICTATION_SAMPLE_RATE * 2;

export type DictationLanguages = {
  readonly codes: readonly string[];
  readonly mode: 'auto' | 'forced' | 'required';
};

export type DictationInterim = 'live' | 'delayed' | 'final-only';

export type DictationAvailability = {
  state: 'ready' | 'needs-setup' | 'unavailable';
  reason?: string;
};

export const DICTATION_ERROR_CODES = ['unavailable', 'needs-setup', 'busy', 'crashed', 'decode-failed', 'network', 'denied'] as const;
export type DictationErrorCode = typeof DICTATION_ERROR_CODES[number];

export type DictationEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: DictationErrorCode; message: string; fatal: boolean }
  | { type: 'stopped' };

export type DictationStartOptions = {
  language: string | null;
  signal: AbortSignal;
  onEvent(event: DictationEvent): void;
};

export type DictationSession = {
  feed(pcm: Float32Array): void;
  stop(): Promise<void>;
  cancel(): void;
};

export type DictationEngine = {
  readonly id: string;
  readonly label: string;
  readonly languages: DictationLanguages;
  readonly interim: DictationInterim;
  availability(): Promise<DictationAvailability>;
  start(options: DictationStartOptions): Promise<DictationSession>;
};

/** Same grammar as the manifest's `dictation.engines[].id` (`orchestrator/src/plugins/manifest.ts`). */
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** What the SDK promises an event carries at most (`DictationEvent`). */
export const MAX_DICTATION_TEXT = 20_000;
const MAX_LABEL = 80;
const MAX_MESSAGE = 2_000;
const MAX_LANGUAGES = 200;
const LANGUAGE_RE = /^[a-z]{2,3}$/;
const LANGUAGE_MODES: readonly string[] = ['auto', 'forced', 'required'];
const INTERIM_MODES: readonly string[] = ['live', 'delayed', 'final-only'];
const AVAILABILITY_STATES: readonly string[] = ['ready', 'needs-setup', 'unavailable'];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readLanguages(value: unknown): DictationLanguages | null {
  const v = record(value);
  if (!v || typeof v.mode !== 'string' || !LANGUAGE_MODES.includes(v.mode)) return null;
  if (!Array.isArray(v.codes) || v.codes.length > MAX_LANGUAGES) return null;
  if (!v.codes.every((code): code is string => typeof code === 'string' && LANGUAGE_RE.test(code))) return null;
  return { codes: v.codes, mode: v.mode as DictationLanguages['mode'] };
}

/**
 * Why `value` cannot be registered as an engine, or null. Read once, at
 * registration: the registry refuses a malformed engine with this reason
 * rather than finding out in the middle of a dictation.
 */
export function dictationEngineProblem(value: unknown): string | null {
  const v = record(value);
  if (!v) return 'expected a DictationEngine object';
  if (typeof v.id !== 'string' || !ENGINE_ID_RE.test(v.id)) return '`id` must be one of the manifest\'s engine ids (a slug, 2 to 40 characters)';
  if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > MAX_LABEL) return `\`label\` must be a non-empty string of at most ${MAX_LABEL} characters`;
  if (!readLanguages(v.languages)) return '`languages` must be { codes: string[] of language subtags, mode: auto | forced | required }';
  if (typeof v.interim !== 'string' || !INTERIM_MODES.includes(v.interim)) return '`interim` must be live, delayed or final-only';
  if (typeof v.availability !== 'function') return '`availability` must be a function';
  if (typeof v.start !== 'function') return '`start` must be a function';
  return null;
}

/** An engine's answer to `availability()`, or null when it is not one. */
export function readDictationAvailability(value: unknown): DictationAvailability | null {
  const v = record(value);
  if (!v || typeof v.state !== 'string' || !AVAILABILITY_STATES.includes(v.state)) return null;
  const reason = typeof v.reason === 'string' ? v.reason.slice(0, MAX_MESSAGE) : undefined;
  return reason ? { state: v.state as DictationAvailability['state'], reason } : { state: v.state as DictationAvailability['state'] };
}

/**
 * An event an engine reported, checked against the contract: a known type,
 * plain text within the bound, an error code of the enum. Null = dropped.
 * Text is never trimmed nor escaped here: it is plain text, and the draft
 * writes it as such.
 */
export function readDictationEvent(value: unknown): DictationEvent | null {
  const v = record(value);
  if (!v) return null;
  switch (v.type) {
    case 'partial':
    case 'final':
      return typeof v.text === 'string' && v.text.length <= MAX_DICTATION_TEXT ? { type: v.type, text: v.text } : null;
    case 'error':
      if (typeof v.code !== 'string' || !(DICTATION_ERROR_CODES as readonly string[]).includes(v.code)) return null;
      if (typeof v.fatal !== 'boolean') return null;
      return {
        type: 'error',
        code: v.code as DictationErrorCode,
        message: typeof v.message === 'string' ? v.message.slice(0, MAX_MESSAGE) : '',
        fatal: v.fatal,
      };
    case 'stopped':
      return { type: 'stopped' };
    default:
      return null;
  }
}
