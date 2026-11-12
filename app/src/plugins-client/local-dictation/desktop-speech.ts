/**
 * The desktop's local dictation bridge, `window.novaDesktop.speech`
 * (desktop/src/preload.cts, docs/DICTATION.md), seen from the app.
 *
 * The app and the desktop are separate packages: these types mirror
 * `desktop/src/speech-ipc.ts` and `speech-model-manager.ts` instead of
 * importing them. Every value the bridge returns is `unknown` on purpose and
 * goes through a guard below — an older or newer desktop may answer with a
 * shape this build does not know, and a wrong guess must read as "not
 * available", never as a crash in the composer.
 */

export const DICTATION_SAMPLE_RATE = 16_000;
/** The IPC refuses a chunk over 2 s of audio (`MAX_FEED_SAMPLES`). */
export const MAX_FEED_SAMPLES = DICTATION_SAMPLE_RATE * 2;

export type EngineAvailability = 'available' | 'unsupported-platform' | 'not-installed';
export type ModelStatus = 'absent' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error';
export type ModelErrorCode = 'network' | 'http' | 'stalled' | 'integrity' | 'disk-full' | 'io';
export type EngineErrorCode = 'engine-unavailable' | 'model-missing' | 'init-failed' | 'engine-crashed' | 'decode-failed' | 'busy';

export type ModelState = {
  modelId: string;
  status: ModelStatus;
  receivedBytes: number;
  totalBytes: number;
  error: ModelErrorCode | null;
};

export type SpeechState = {
  engine: EngineAvailability;
  model: ModelState;
  sessionId: string | null;
};

export type InterimMode = 'live' | 'delayed' | 'final-only';
/** The user's provisional-text setting; `auto` follows the model. */
export type InterimChoice = 'auto' | InterimMode;

/**
 * What runs, when the desktop says it (TODO #484): the model may differ from
 * the one asked for (a fallback), and `interim` may be stricter than the
 * user's choice (a slow model cannot be made live). Absent from an older desktop.
 */
export type StartedSession = { modelId: string; language: string | null; interim: InterimMode };

export type StartResult =
  | { ok: true; sessionId: string; session?: StartedSession }
  | { ok: false; code: EngineErrorCode; message: string };

/** What a dictation asks the desktop for; all optional, the desktop picks the model that fits. */
export type StartRequest = {
  modelId?: string;
  /** `auto` or a BCP 47 tag (`fr`, `fr-FR`). */
  language?: string;
  interim?: InterimChoice;
};

/**
 * Where a model of the catalog comes from. `pack`: the plugin whose installed
 * package ships the entry — the desktop read it from the daemon under that
 * id (TODO #584). It says where the entry comes from, not who asked for it.
 */
export type ModelOrigin = { kind: 'builtin' } | { kind: 'pack'; pluginId: string } | { kind: 'local' };

/** The words a catalog entry may wear, from the desktop's closed list (`SPEECH_MODEL_TIERS`). */
export const MODEL_TIERS = ['precise'] as const;
export type ModelTier = typeof MODEL_TIERS[number];

/** A model of the desktop's live catalog (TODO #484), reduced to what the app reads of it. */
export type ModelListing = {
  id: string;
  label: string;
  /** Null when the desktop did not say; a family this build does not know is still shown. */
  family: string | null;
  origin: ModelOrigin;
  /** Every file together, from the catalog; 0 when unknown. */
  sizeBytes: number;
  /** Resident memory while it dictates, measured by whoever wrote the entry; null when unknown. */
  ramBytes: number | null;
  /** The most memory it takes, during a decode; null when unknown or below `ramBytes`. */
  peakRamBytes: number | null;
  /** The product word the pane puts on it (`precise`); null for none, or one this build does not know. */
  tier: ModelTier | null;
  languages: { codes: string[]; mode: 'auto' | 'forced' | 'required' };
  /** The model's own provisional-text mode; null when unknown. */
  interim: InterimMode | null;
  license: { spdx: string; attribution: string; url: string | null } | null;
  state: ModelState;
};

export type ImportErrorCode =
  | 'cancelled' | 'busy' | 'engine-unavailable'
  | 'not-a-folder' | 'symlink' | 'special-file' | 'nested-folder' | 'extension' | 'file-name' | 'too-many-files' | 'too-large'
  | 'family-needed' | 'roles' | 'languages-needed' | 'unsupported-family'
  | 'unsafe-graph' | 'changed' | 'disk-full' | 'load-failed' | 'io';

/** What an import may say about the folder; never a path. */
export type ImportRequest = { family?: string; languages?: string[] };

/** `not-found`: no active plugin ships that entry; `unavailable`: the desktop could not read it from Rooks. */
export type PackErrorCode = 'invalid' | 'unknown-family' | 'exists' | 'declined' | 'busy' | 'engine-unavailable' | 'not-found' | 'unavailable';

/** Names an entry of an installed plugin's pack; the desktop reads the entry itself. */
export type PackRequest = { pluginId: string; modelId: string };

export type PackResult =
  | { ok: true; modelId: string; state: ModelState }
  | { ok: false; code: PackErrorCode; message: string };

export type ImportResult =
  | { ok: true; modelId: string; state: ModelState }
  | { ok: false; code: ImportErrorCode; message: string; candidates: string[] };

export type SpeechEvent =
  | { type: 'model-state'; state: ModelState }
  | { type: 'partial'; sessionId: string; text: string }
  | { type: 'final'; sessionId: string; text: string }
  | { type: 'error'; sessionId: string; code: EngineErrorCode; message: string }
  | { type: 'stopped'; sessionId: string };

export type MicrophoneStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/** The raw bridge, as the preload exposes it. */
export type RawSpeechBridge = {
  getState: (modelId?: string) => Promise<unknown>;
  downloadModel: (modelId?: string) => Promise<unknown>;
  cancelDownload: (modelId?: string) => Promise<boolean>;
  deleteModel: (modelId?: string) => Promise<unknown>;
  startDictation: (modelId?: string, language?: string, interim?: string) => Promise<unknown>;
  /** Absent from a desktop older than the multi-model catalog (TODO #484). */
  listModels?: () => Promise<unknown>;
  /** The main process opens the folder picker; absent from a desktop older than A3 (TODO #484). */
  importModel?: (request?: ImportRequest) => Promise<unknown>;
  /** Absent from a desktop older than packs (TODO #484); an older one also takes another request shape (TODO #584). */
  proposePack?: (request: PackRequest) => Promise<unknown>;
  feed: (sessionId: string, samples: Float32Array) => void;
  stopDictation: (sessionId: string) => Promise<void>;
  cancelDictation: (sessionId: string) => Promise<void>;
  microphone: (request?: boolean) => Promise<{ status: string }>;
  onEvent: (listener: (event: unknown) => void) => () => void;
};

/** The bridge with its answers checked. What the rest of the app talks to. */
export type SpeechBridge = {
  /** Without an id: the desktop's default model. */
  getState(modelId?: string): Promise<SpeechState | null>;
  downloadModel(modelId?: string): Promise<ModelState | null>;
  cancelDownload(modelId?: string): Promise<boolean>;
  deleteModel(modelId?: string): Promise<ModelState | null>;
  startDictation(request?: StartRequest): Promise<StartResult>;
  /** The live catalog; null when the desktop cannot list it (older, or an answer this build does not read). */
  listModels(): Promise<ModelListing[] | null>;
  /** Null when this desktop cannot import. */
  importModel(request?: ImportRequest): Promise<ImportResult | null>;
  /** Null when this desktop cannot take a plugin's model. */
  proposePack(request: PackRequest): Promise<PackResult | null>;
  feed(sessionId: string, samples: Float32Array): void;
  stopDictation(sessionId: string): Promise<void>;
  cancelDictation(sessionId: string): Promise<void>;
  microphone(request?: boolean): Promise<MicrophoneStatus>;
  onEvent(listener: (event: SpeechEvent) => void): () => void;
};

const ENGINES: readonly string[] = ['available', 'unsupported-platform', 'not-installed'];
const STATUSES: readonly string[] = ['absent', 'partial', 'downloading', 'verifying', 'ready', 'error'];
const MODEL_ERRORS: readonly string[] = ['network', 'http', 'stalled', 'integrity', 'disk-full', 'io'];
const ENGINE_ERRORS: readonly string[] = ['engine-unavailable', 'model-missing', 'init-failed', 'engine-crashed', 'decode-failed', 'busy'];
const MIC_STATUSES: readonly string[] = ['granted', 'denied', 'restricted', 'not-determined', 'unknown'];
const LANGUAGE_MODES: readonly string[] = ['auto', 'forced', 'required'];
const INTERIM_MODES: readonly string[] = ['live', 'delayed', 'final-only'];
const PACK_ERRORS: readonly string[] = ['invalid', 'unknown-family', 'exists', 'declined', 'busy', 'engine-unavailable', 'not-found', 'unavailable'];
const IMPORT_ERRORS: readonly string[] = [
  'cancelled', 'busy', 'engine-unavailable',
  'not-a-folder', 'symlink', 'special-file', 'nested-folder', 'extension', 'file-name', 'too-many-files', 'too-large',
  'family-needed', 'roles', 'languages-needed', 'unsupported-family',
  'unsafe-graph', 'changed', 'disk-full', 'load-failed', 'io',
];
/** The grammars of the desktop's catalog (`speech-catalog/schema.ts`), checked again: they reach the DOM and the IPC. */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const FAMILY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
/** Bidi overrides and control characters: a label is a plugin's text, shown as is. */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Above the desktop's own bounds: a list this long is not a catalog. */
const MAX_LISTED_MODELS = 64;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function readModelState(value: unknown): ModelState | null {
  const v = record(value);
  if (!v) return null;
  if (typeof v.modelId !== 'string' || typeof v.status !== 'string' || !STATUSES.includes(v.status)) return null;
  if (!count(v.receivedBytes) || !count(v.totalBytes)) return null;
  const error = v.error === null || v.error === undefined ? null
    : typeof v.error === 'string' && MODEL_ERRORS.includes(v.error) ? v.error as ModelErrorCode
      // An error code this build does not know is still an error: `io` is the closest generic one.
      : 'io';
  return { modelId: v.modelId, status: v.status as ModelStatus, receivedBytes: v.receivedBytes, totalBytes: v.totalBytes, error };
}

export function readSpeechState(value: unknown): SpeechState | null {
  const v = record(value);
  if (!v || typeof v.engine !== 'string' || !ENGINES.includes(v.engine)) return null;
  const model = readModelState(v.model);
  if (!model) return null;
  return { engine: v.engine as EngineAvailability, model, sessionId: typeof v.sessionId === 'string' ? v.sessionId : null };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(UNSAFE_TEXT, '').trim().slice(0, max);
  return clean || null;
}

function readOrigin(value: unknown): ModelOrigin | null {
  const v = record(value);
  if (v?.kind === 'builtin' || v?.kind === 'local') return { kind: v.kind };
  if (v?.kind === 'pack' && typeof v.pluginId === 'string' && PLUGIN_ID.test(v.pluginId)) return { kind: 'pack', pluginId: v.pluginId };
  return null;
}

function readLicense(value: unknown): ModelListing['license'] {
  const v = record(value);
  const spdx = text(v?.spdx, 64);
  const attribution = text(v?.attribution, 300);
  if (!spdx || !attribution) return null;
  let url: string | null = null;
  if (typeof v?.url === 'string') {
    try {
      // Only an https link is ever rendered as one.
      url = new URL(v.url).protocol === 'https:' ? v.url : null;
    } catch {
      url = null;
    }
  }
  return { spdx, attribution, url };
}

function filesSize(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const file of value) {
    const size = record(file)?.sizeBytes;
    if (!count(size)) return 0;
    total += size;
  }
  return total;
}

function readListing(value: unknown): ModelListing | null {
  const v = record(value);
  const model = record(v?.model);
  const languages = record(model?.languages);
  const state = readModelState(v?.state);
  const origin = readOrigin(v?.origin);
  if (!v || typeof v.id !== 'string' || !MODEL_ID.test(v.id) || !state || state.modelId !== v.id || !languages || !origin) return null;
  const { codes, mode } = languages;
  if (typeof mode !== 'string' || !LANGUAGE_MODES.includes(mode)) return null;
  if (!Array.isArray(codes) || !codes.every((code): code is string => typeof code === 'string' && LANGUAGE.test(code))) return null;
  const ram = record(model?.memory)?.ramBytes;
  const peak = record(model?.memory)?.peakRamBytes;
  const ramBytes = count(ram) && ram > 0 ? ram : null;
  const interim = record(model?.interim)?.mode;
  const tier = model?.tier;
  return {
    id: v.id,
    label: text(model?.label, 120) ?? v.id,
    family: typeof model?.family === 'string' && FAMILY.test(model.family) ? model.family : null,
    origin,
    sizeBytes: filesSize(model?.files) || state.totalBytes,
    ramBytes,
    peakRamBytes: count(peak) && peak > 0 && peak >= (ramBytes ?? 0) ? peak : null,
    tier: typeof tier === 'string' && (MODEL_TIERS as readonly string[]).includes(tier) ? tier as ModelTier : null,
    languages: { codes, mode: mode as ModelListing['languages']['mode'] },
    interim: typeof interim === 'string' && INTERIM_MODES.includes(interim) ? interim as InterimMode : null,
    license: readLicense(model?.license),
    state,
  };
}

/** The live catalog; an entry this build cannot read is left out, not the whole list. */
export function readModelListings(value: unknown): ModelListing[] | null {
  if (!Array.isArray(value) || value.length > MAX_LISTED_MODELS) return null;
  return value.map(readListing).filter((entry): entry is ModelListing => entry !== null);
}

function engineError(value: unknown): EngineErrorCode {
  return typeof value === 'string' && ENGINE_ERRORS.includes(value) ? value as EngineErrorCode : 'init-failed';
}

export function readStartResult(value: unknown): StartResult {
  const v = record(value);
  if (v?.ok === true && typeof v.sessionId === 'string' && v.sessionId) {
    const language = v.language === null ? null : typeof v.language === 'string' && LANGUAGE.test(v.language) ? v.language : undefined;
    const known = typeof v.modelId === 'string' && MODEL_ID.test(v.modelId) && language !== undefined
      && typeof v.interim === 'string' && INTERIM_MODES.includes(v.interim);
    return known
      ? { ok: true, sessionId: v.sessionId, session: { modelId: v.modelId as string, language: language ?? null, interim: v.interim as InterimMode } }
      : { ok: true, sessionId: v.sessionId };
  }
  return { ok: false, code: engineError(v?.code), message: typeof v?.message === 'string' ? v.message : '' };
}

export function readImportResult(value: unknown): ImportResult {
  const v = record(value);
  const state = readModelState(v?.state);
  const id = record(v?.model)?.id;
  if (v?.ok === true && state && typeof id === 'string' && id === state.modelId && MODEL_ID.test(id)) return { ok: true, modelId: id, state };
  const code = typeof v?.code === 'string' && IMPORT_ERRORS.includes(v.code) && v.ok === false ? v.code as ImportErrorCode : 'io';
  const candidates = Array.isArray(v?.candidates)
    ? v.candidates.filter((family): family is string => typeof family === 'string' && FAMILY.test(family)).slice(0, 8)
    : [];
  return { ok: false, code, message: typeof v?.message === 'string' ? v.message.slice(0, 300) : '', candidates };
}

export function readPackResult(value: unknown): PackResult {
  const v = record(value);
  const state = readModelState(v?.state);
  if (v?.ok === true && state && typeof v.modelId === 'string' && v.modelId === state.modelId && MODEL_ID.test(v.modelId)) {
    return { ok: true, modelId: v.modelId, state };
  }
  // An older desktop refuses the request shape by throwing: the same as not reading it.
  const code = v?.ok === false && typeof v.code === 'string' && PACK_ERRORS.includes(v.code) ? v.code as PackErrorCode : 'unavailable';
  return { ok: false, code, message: typeof v?.message === 'string' ? v.message.slice(0, 300) : '' };
}

/**
 * The entries of a plugin's pack as the daemon serves them
 * (`GET /api/plugins/:id/-/dictation-models`), read like a catalog entry:
 * what the pane shows of a model it does not have yet. Only entries named
 * under the plugin's own id; their state is `absent` until the desktop adds them.
 */
export function readPackOffers(pluginId: string, value: unknown): ModelListing[] {
  const v = record(value);
  if (!PLUGIN_ID.test(pluginId) || v?.pluginId !== pluginId || !Array.isArray(v.models)) return [];
  const offers: ModelListing[] = [];
  for (const entry of v.models.slice(0, 16)) {
    const id = record(entry)?.id;
    if (typeof id !== 'string' || !MODEL_ID.test(id) || !id.startsWith(`${pluginId}.`)) continue;
    const listing = readListing({
      id,
      model: entry,
      origin: { kind: 'pack', pluginId },
      state: { modelId: id, status: 'absent', receivedBytes: 0, totalBytes: filesSize(record(entry)?.files), error: null },
    });
    if (listing) offers.push(listing);
  }
  return offers;
}

export function readSpeechEvent(value: unknown): SpeechEvent | null {
  const v = record(value);
  if (!v || typeof v.type !== 'string') return null;
  if (v.type === 'model-state') {
    const state = readModelState(v.state);
    return state ? { type: 'model-state', state } : null;
  }
  if (typeof v.sessionId !== 'string') return null;
  const sessionId = v.sessionId;
  switch (v.type) {
    case 'partial':
    case 'final':
      return typeof v.text === 'string' ? { type: v.type, sessionId, text: v.text } : null;
    case 'error':
      return { type: 'error', sessionId, code: engineError(v.code), message: typeof v.message === 'string' ? v.message : '' };
    case 'stopped':
      return { type: 'stopped', sessionId };
    default:
      return null;
  }
}

function isRawBridge(value: unknown): value is RawSpeechBridge {
  const v = record(value);
  if (!v) return false;
  return ['getState', 'downloadModel', 'cancelDownload', 'deleteModel', 'startDictation', 'feed', 'stopDictation', 'cancelDictation', 'microphone', 'onEvent']
    .every((name) => typeof v[name] === 'function');
}

/** Wraps a raw bridge; exported for the tests, which hand it a fake. */
export function wrapSpeechBridge(raw: RawSpeechBridge): SpeechBridge {
  return {
    getState: async (modelId) => readSpeechState(await raw.getState(modelId)),
    downloadModel: async (modelId) => readModelState(await raw.downloadModel(modelId)),
    cancelDownload: async (modelId) => (await raw.cancelDownload(modelId)) === true,
    deleteModel: async (modelId) => readModelState(await raw.deleteModel(modelId)),
    startDictation: async (request = {}) => readStartResult(await raw.startDictation(request.modelId, request.language, request.interim)),
    listModels: async () => (raw.listModels ? readModelListings(await raw.listModels().catch(() => null)) : null),
    importModel: async (request) => {
      if (!raw.importModel) return null;
      // Only what the IPC schema takes, nothing else of the caller's object.
      const clean: ImportRequest = {};
      if (request?.family) clean.family = request.family;
      if (request?.languages?.length) clean.languages = [...request.languages];
      return readImportResult(await raw.importModel(Object.keys(clean).length ? clean : undefined).catch(() => ({ ok: false, code: 'io' })));
    },
    proposePack: async (request) => {
      if (!raw.proposePack) return null;
      // Only the two names the IPC takes: the entry itself never crosses.
      const answer = await raw.proposePack({ pluginId: request.pluginId, modelId: request.modelId }).catch(() => null);
      return readPackResult(answer);
    },
    feed: (sessionId, samples) => raw.feed(sessionId, samples),
    stopDictation: (sessionId) => raw.stopDictation(sessionId),
    cancelDictation: (sessionId) => raw.cancelDictation(sessionId),
    microphone: async (request) => {
      const answer = record(await raw.microphone(request));
      const status = answer?.status;
      return typeof status === 'string' && MIC_STATUSES.includes(status) ? status as MicrophoneStatus : 'unknown';
    },
    onEvent: (listener) => raw.onEvent((event) => {
      const parsed = readSpeechEvent(event);
      if (parsed) listener(parsed);
    }),
  };
}

let cached: { raw: unknown; bridge: SpeechBridge | null } | null = null;

/**
 * The local dictation bridge of the desktop app, or null: in a browser, and in
 * a desktop older than local dictation (0.1.x before TODO #443).
 */
export function speechBridge(): SpeechBridge | null {
  if (typeof window === 'undefined') return null;
  const raw: unknown = window.novaDesktop?.speech;
  if (cached && cached.raw === raw) return cached.bridge;
  const bridge = isRawBridge(raw) ? wrapSpeechBridge(raw) : null;
  cached = { raw, bridge };
  return bridge;
}
