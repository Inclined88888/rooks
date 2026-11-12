import type { InterimChoice } from './desktop-speech';

/**
 * The local engine's own settings (Settings → Interface → Voice dictation):
 * the dictation language, the provisional-text mode and the model chosen per
 * language. Kept by this client, in its `localStorage`: the models live on
 * this machine, so a choice made on another one would name models it does
 * not have (vault note §4, assumption of the TODO #484 orchestrator).
 */

export const VOICE_SETTINGS_KEY = 'rooks.dictation.local';

export type VoiceSettings = {
  /** `auto`, a language code, or null: never chosen (the UI language when a model covers it). */
  language: string | null;
  interim: InterimChoice;
  /** `auto` or a language code → the model the user picked for it; absent = automatic. */
  models: Readonly<Record<string, string>>;
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { language: null, interim: 'auto', models: {} };

const LANGUAGE_KEY = /^(auto|[a-z]{2,3})$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const INTERIM_CHOICES: readonly string[] = ['auto', 'live', 'delayed', 'final-only'];
/** More languages than any catalog lists: a bigger map is not ours. */
const MAX_MODEL_CHOICES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stored value, read defensively: anything unreadable is the default, one field at a time. */
export function readVoiceSettings(raw: unknown): VoiceSettings {
  if (!isRecord(raw) || raw.v !== 1) return DEFAULT_VOICE_SETTINGS;
  const language = typeof raw.language === 'string' && LANGUAGE_KEY.test(raw.language) ? raw.language : null;
  const interim = typeof raw.interim === 'string' && INTERIM_CHOICES.includes(raw.interim) ? raw.interim as InterimChoice : 'auto';
  const models: Record<string, string> = {};
  if (isRecord(raw.models)) {
    for (const [key, id] of Object.entries(raw.models).slice(0, MAX_MODEL_CHOICES)) {
      if (LANGUAGE_KEY.test(key) && typeof id === 'string' && MODEL_ID.test(id)) models[key] = id;
    }
  }
  return { language, interim, models };
}

export function writeVoiceSettings(settings: VoiceSettings): { v: 1 } & VoiceSettings {
  const clean = readVoiceSettings({ v: 1, ...settings });
  return { v: 1, ...clean, models: { ...clean.models } };
}

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: VoiceSettings | null = null;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // A sandboxed or privacy-locked page throws on access: settings stay at their defaults.
    return null;
  }
}

function load(): VoiceSettings {
  const raw = storage()?.getItem(VOICE_SETTINGS_KEY);
  if (!raw) return DEFAULT_VOICE_SETTINGS;
  try {
    return readVoiceSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

/** The settings now; the same object until they change (a `useSyncExternalStore` snapshot). */
export function voiceSettings(): VoiceSettings {
  cached ??= load();
  return cached;
}

function publish(): void {
  for (const listener of [...listeners]) listener();
}

let watching = false;

/** Another window of this client changed them: reread. */
function watchOtherWindows(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== VOICE_SETTINGS_KEY) return;
    cached = null;
    publish();
  });
}

export function subscribeVoiceSettings(listener: Listener): () => void {
  watchOtherWindows();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function updateVoiceSettings(change: (current: VoiceSettings) => VoiceSettings): VoiceSettings {
  const next = writeVoiceSettings(change(voiceSettings()));
  try {
    storage()?.setItem(VOICE_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Full or locked storage: the choice holds for this window only.
  }
  const { v: _version, ...settings } = next;
  cached = settings;
  publish();
  return settings;
}

/** For the tests: forget the cached copy so the next read loads again. */
export function resetVoiceSettingsCache(): void {
  cached = null;
}
