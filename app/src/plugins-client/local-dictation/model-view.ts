import type { EngineAvailability, ModelErrorCode, ModelListing, ModelState, SpeechState } from './desktop-speech';
import type { VoiceSettings } from './voice-settings';
import { formatNumber } from '@rooks/ui';

/**
 * What the consent card and the settings pane show for the speech models,
 * from the desktop's state and catalog alone, and which model a language
 * gets. Pure, so every state is tested without rendering.
 */

export type ModelPhase =
  /** First answer from the desktop still on its way. */
  | 'loading'
  /** This desktop cannot run the engine (no addon, unsupported OS). */
  | 'unavailable'
  /** Not downloaded, and the user has not accepted the download yet. */
  | 'consent'
  | 'downloading'
  /** Bytes on disk waiting for a resume. */
  | 'paused'
  | 'verifying'
  | 'ready'
  | 'error';

export type ModelView = {
  phase: ModelPhase;
  receivedBytes: number;
  totalBytes: number;
  /** 0–100, whole numbers. */
  percent: number;
  error: ModelErrorCode | null;
};

/**
 * `accepted`: the user clicked Download in THIS card. A partial download left
 * by an earlier session asks for consent again rather than resume silently.
 */
export function modelView(state: SpeechState | null, accepted: boolean): ModelView {
  if (!state) return { phase: 'loading', receivedBytes: 0, totalBytes: 0, percent: 0, error: null };
  return modelStateView(state.engine, state.model, accepted);
}

/** The same, for any model of the catalog. */
export function modelStateView(engine: EngineAvailability, model: ModelState, accepted: boolean): ModelView {
  const base = {
    receivedBytes: model.receivedBytes,
    totalBytes: model.totalBytes,
    percent: model.totalBytes > 0 ? Math.min(100, Math.floor((model.receivedBytes / model.totalBytes) * 100)) : 0,
    error: null,
  };
  if (engine !== 'available') return { ...base, phase: 'unavailable' };
  switch (model.status) {
    case 'ready': return { ...base, phase: 'ready', percent: 100 };
    case 'downloading': return { ...base, phase: 'downloading' };
    case 'verifying': return { ...base, phase: 'verifying' };
    case 'error': return { ...base, phase: 'error', error: model.error ?? 'io' };
    case 'partial': return { ...base, phase: accepted ? 'paused' : 'consent' };
    case 'absent': return { ...base, phase: 'consent' };
  }
}

/**
 * A byte count for a person, in the UI locale's own unit words ("670 MB",
 * "670 Mo"). Decimal units, like the download size a browser shows. The size
 * of the model is read from the desktop's catalogue at runtime and never
 * written in a locale file: a catalogue change would leave it wrong.
 */
export function formatBytes(bytes: number, locale: string): string {
  const megabytes = bytes / 1_000_000;
  // Never below the megabyte: a download progress reads `0 Mo / 670 Mo`, not `0 octet`.
  if (megabytes >= 1000) {
    return formatNumber(megabytes / 1000, { style: 'unit', unit: 'gigabyte', unitDisplay: 'short', maximumFractionDigits: 1 }, locale);
  }
  return formatNumber(megabytes, { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: megabytes < 10 ? 1 : 0 }, locale);
}

/** From this size on, Download asks once more, with the size and the memory spelled out. */
export const LARGE_DOWNLOAD_BYTES = 1_000_000_000;

/**
 * Whether the catalog's Download first shows what it costs: a model of a
 * gigabyte or more (Cohere Transcribe, 2.9 GB) takes minutes, disk and
 * memory the user should agree to knowingly, not on a stray click.
 */
export function confirmsDownload(entry: Pick<ModelListing, 'sizeBytes'>): boolean {
  return entry.sizeBytes >= LARGE_DOWNLOAD_BYTES;
}

/** i18n key of a download failure, under `dictation.model.errors`. */
export function modelErrorKey(error: ModelErrorCode): string {
  return `dictation.model.errors.${error === 'disk-full' ? 'diskFull' : error}`;
}

/** `und`: an import that detects the language and claims none. Not a language to offer. */
const NO_LANGUAGE = 'und';

/** Every language some model of the catalog can dictate, sorted. */
export function catalogLanguages(listing: readonly ModelListing[]): string[] {
  const codes = new Set(listing.flatMap((entry) => entry.languages.codes).filter((code) => code !== NO_LANGUAGE));
  return [...codes].sort();
}

function covers(listing: readonly ModelListing[] | null, code: string): boolean {
  return listing === null || listing.some((entry) => entry.languages.codes.includes(code));
}

/**
 * The language a dictation runs in: the user's choice; else, never chosen,
 * `fallback` (the surface's, i.e. the UI's) when a model covers it; else
 * Auto. A choice no model covers any more (its import was deleted) falls
 * back the same way. With no catalog (an older desktop), nothing is refused.
 */
export function effectiveLanguage(chosen: string | null, fallback: string | null, listing: readonly ModelListing[] | null): string {
  if (chosen === 'auto') return 'auto';
  if (chosen && covers(listing, chosen)) return chosen;
  if (fallback && fallback !== 'auto' && covers(listing, fallback)) return fallback;
  return 'auto';
}

/** Whether a model can dictate in `lang`: a detecting one always does, others only their languages, never Auto. */
export function canTake(entry: ModelListing, lang: string): boolean {
  if (entry.languages.mode === 'auto') return true;
  return lang !== 'auto' && entry.languages.codes.includes(lang);
}

const isReady = (entry: ModelListing): boolean => entry.state.status === 'ready';

/**
 * The model the desktop picks by itself for `lang` (mirror of its
 * `resolveModel`): one that imposes the language first, else one that
 * detects it, else any detecting one. A `required` model (no Auto, final
 * text only) is never picked by itself.
 */
export function automaticModel(
  lang: string,
  listing: readonly ModelListing[],
  usable: (entry: ModelListing) => boolean = isReady,
): ModelListing | null {
  if (lang !== 'auto') {
    const forced = listing.find((entry) => entry.languages.mode === 'forced' && entry.languages.codes.includes(lang) && usable(entry));
    if (forced) return forced;
    const detecting = listing.find((entry) => entry.languages.mode === 'auto' && entry.languages.codes.includes(lang) && usable(entry));
    if (detecting) return detecting;
  }
  return listing.find((entry) => entry.languages.mode === 'auto' && usable(entry)) ?? null;
}

/** The model the user picked for `lang`, when it is installed and can take it; else undefined (automatic). */
export function chosenModel(lang: string, settings: VoiceSettings, listing: readonly ModelListing[]): ModelListing | undefined {
  const id = settings.models[lang];
  const entry = id ? listing.find((candidate) => candidate.id === id) : undefined;
  return entry && isReady(entry) && canTake(entry, lang) ? entry : undefined;
}

/** The model a dictation in `lang` runs on now, or null when none installed fits. */
export function activeModel(lang: string, settings: VoiceSettings, listing: readonly ModelListing[]): ModelListing | null {
  return chosenModel(lang, settings, listing) ?? automaticModel(lang, listing);
}

/** The installed models the user may pick for `lang`. */
export function modelChoices(lang: string, listing: readonly ModelListing[]): ModelListing[] {
  return listing.filter((entry) => isReady(entry) && canTake(entry, lang));
}

/** The model to download for `lang` when none fits: what the desktop would pick once everything is installed. */
export function recommendedModel(lang: string, listing: readonly ModelListing[]): ModelListing | null {
  return automaticModel(lang, listing, (entry) => entry.origin.kind !== 'local' || isReady(entry));
}

/**
 * The card "a precise model for French": an install that dictates `lang`
 * with a detecting model (Parakeet) while a built-in model imposes it
 * (Canary) and is not installed. Once that one is ready, the desktop picks
 * it by itself.
 */
export function preciseSuggestion(lang: string, listing: readonly ModelListing[]): ModelListing | null {
  if (lang === 'auto') return null;
  const current = automaticModel(lang, listing);
  if (!current || current.languages.mode !== 'auto') return null;
  const precise = listing.find((entry) => (
    entry.origin.kind === 'builtin' && entry.languages.mode === 'forced' && entry.languages.codes.includes(lang) && !isReady(entry)
  ));
  return precise ?? null;
}

/**
 * A language's name in the UI language (`Français`, "French"); the code
 * when the runtime has no name for it. `inSentence`: as the locale writes
 * it mid-sentence (`français`).
 */
export function languageName(code: string, locale: string, inSentence = false): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
    if (!name || name === code) return code;
    return inSentence ? name : name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return code;
  }
}
