import { z } from 'zod';
import { DEFAULT_SPEECH_MODEL_ID, primaryLanguage, resolveModel, speechModel, type ResolvedModel } from './speech-catalog/builtin.js';
import { needsLanguage, type ModelFamily } from './speech-catalog/families.js';
import { parseSpeechModel, type SpeechModel } from './speech-catalog/schema.js';
import { EngineError } from './speech-engine-host.js';
import { importModelFolder, ImportRefused, importRequestSchema, probeTimeoutMs, type ImportErrorCode, type ImportRequest } from './speech-import.js';
import { PLUGIN_ID, type CatalogModel, type ModelOrigin, type ModelState, type VetResult } from './speech-model-manager.js';
import { INTERIM_MODES, interimPolicy, type InterimMode, type InterimPolicy } from './speech-segmenter.js';
import type { MicrophoneAccess, MicrophoneStatus } from './window-permissions.js';
import {
  DICTATION_SAMPLE_RATE, MAX_FEED_SAMPLES, WORKER_FILE_ROLES, workerInitSchema,
  type DictationErrorCode, type DictationEvent, type SpeechLanguage, type WorkerFileRole, type WorkerInit,
} from './speech-protocol.js';

/**
 * Local dictation over IPC (TODO #443): the channels exposed to the Timon
 * window through `window.timonDesktop.speech` (preload.cts), their input
 * schemas, and the controller that ties the model manager to the engine.
 *
 * Every handler checks the sender (the Timon window, main frame, its origin)
 * and parses its input with zod before anything else; a model is named by
 * catalog id, never by a path, and the id must name a model of the live
 * catalog (built in, a confirmed pack, an import: TODO #484, A3).
 *
 * The renderer is the realm every client plugin shares: it cannot be the only
 * barrier. A local import starts from a folder picker the main process opens
 * and the renderer never sees; a plugin's pack is only *named* by the
 * renderer (plugin id, model id): the main process reads the entry itself
 * from the daemon that installed the plugin (TODO #584), then asks the user
 * in a native box it owns.
 */

export const SPEECH_CHANNELS = {
  state: 'timon:speech-state',
  download: 'timon:speech-download',
  cancelDownload: 'timon:speech-cancel-download',
  deleteModel: 'timon:speech-delete-model',
  start: 'timon:speech-start',
  feed: 'timon:speech-feed',
  stop: 'timon:speech-stop',
  cancel: 'timon:speech-cancel',
  /** The OS's microphone answer; `{ request: true }` prompts on macOS. */
  microphone: 'timon:speech-microphone',
  /** Every model of the live catalog, with its origin and state. */
  listModels: 'timon:speech-list-models',
  /** Opens the native folder picker; `{ family?, languages? }`, never a path. */
  importModel: 'timon:speech-import-model',
  /** `{ pluginId, modelId }`: an entry of an installed plugin's pack, read from the daemon, confirmed in a native box. */
  proposePack: 'timon:speech-propose-pack',
  /** Main → renderer: `SpeechEvent`. */
  event: 'timon:speech-event',
} as const;

const sessionId = z.string().uuid();
/** The id grammar of the catalog; whether it names a model is asked to the live catalog. */
const modelId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/);

/** `auto`, or a BCP 47 tag whose primary language is read (`fr`, `fr-FR`); never a path. */
const languageTag = z.string().max(35).regex(/^(auto|[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*)$/, 'expected a language tag');
/** The user's provisional-text setting; `auto` follows the model. */
export const INTERIM_CHOICES = ['auto', ...INTERIM_MODES] as const;
export type InterimChoice = typeof INTERIM_CHOICES[number];
export const startRequestSchema = z.object({
  modelId: modelId.optional(),
  language: languageTag.optional(),
  interim: z.enum(INTERIM_CHOICES).optional(),
}).strict().optional();
export const modelRequestSchema = z.object({ modelId: modelId.optional() }).strict().optional();
/** Names an entry, never carries one: the entry is read from the daemon (TODO #584). */
export const packRequestSchema = z.strictObject({ pluginId: z.string().regex(PLUGIN_ID), modelId });
export { importRequestSchema };
export const feedRequestSchema = z.object({
  sessionId,
  samples: z.custom<Float32Array>(
    (value) => value instanceof Float32Array && value.length > 0 && value.length <= MAX_FEED_SAMPLES,
    'expected a Float32Array of 1 to 2 s of audio',
  ),
  sampleRate: z.literal(DICTATION_SAMPLE_RATE),
}).strict();
export const sessionRequestSchema = z.object({ sessionId }).strict();
export const microphoneRequestSchema = z.object({ request: z.boolean().optional() }).strict().optional();

/** Whether this machine can run the recognizer at all. */
export type EngineAvailability = 'available' | 'unsupported-platform' | 'not-installed';

export type SpeechState = {
  engine: EngineAvailability;
  model: ModelState;
  /** The dictation in progress, if any. */
  sessionId: string | null;
};

export type SpeechEvent = DictationEvent | { type: 'model-state'; state: ModelState };

export type StartResult =
  /**
   * `modelId` and `language` say what runs: a fallback may differ from what
   * was asked. `interim` is the provisional text it shows, which may be
   * stricter than the user's choice (a slow model cannot be made live).
   */
  | { ok: true; sessionId: string; modelId: string; language: string | null; interim: InterimMode }
  | { ok: false; code: DictationErrorCode; message: string };

export type ModelListing = { id: string; model: SpeechModel; origin: ModelOrigin; state: ModelState };

export type ImportResult =
  | { ok: true; model: SpeechModel; state: ModelState }
  | { ok: false; code: ImportErrorCode; message: string; file?: string; candidates?: ModelFamily[] };

export type PackResult =
  | { ok: true; modelId: string; state: ModelState }
  | { ok: false; code: PackErrorCode; message: string; issues?: string[] };
/** `not-found`: no active plugin of that id ships that entry; `unavailable`: the daemon did not answer. */
export type PackErrorCode = 'invalid' | 'unknown-family' | 'exists' | 'declined' | 'busy' | 'engine-unavailable' | 'not-found' | 'unavailable';

/**
 * An installed plugin's pack, as the daemon serves it
 * (`GET /api/plugins/:id/-/dictation-models`). The entries are still
 * untrusted data: the controller parses the one it uses.
 */
export type PluginPack = { ok: true; models: unknown[] } | { ok: false; code: 'not-found' | 'unavailable' };
export type PackSource = (pluginId: string) => Promise<PluginPack>;

/** Above the daemon's own bounds (256 KiB, 16 entries): an answer this large is not a pack. */
const MAX_PACK_RESPONSE_CHARS = 512 * 1024;
const MAX_PACK_ENTRIES = 16;

type PackFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Reads a plugin's pack through the app origin, as the signed-in user (the
 * window's session carries the cookie): the daemon answers for the plugins
 * this user sees, active ones only. Any doubt reads as `unavailable`.
 */
export async function fetchPluginPack(fetch: PackFetch, origin: string, pluginId: string): Promise<PluginPack> {
  if (!PLUGIN_ID.test(pluginId)) return { ok: false, code: 'not-found' };
  let response: Response;
  try {
    // portability: URL, not a filesystem path
    response = await fetch(`${origin}/api/ui/plugins/${encodeURIComponent(pluginId)}/-/dictation-models`, {
      credentials: 'include',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: 'unavailable' };
  }
  if (response.status === 404) return { ok: false, code: 'not-found' };
  if (response.status !== 200) return { ok: false, code: 'unavailable' };
  try {
    const text = await response.text();
    if (text.length > MAX_PACK_RESPONSE_CHARS) return { ok: false, code: 'unavailable' };
    const body = JSON.parse(text) as { pluginId?: unknown; models?: unknown };
    // The daemon echoes the id it resolved: another answer is not this plugin's pack.
    if (body?.pluginId !== pluginId || !Array.isArray(body.models) || body.models.length > MAX_PACK_ENTRIES) {
      return { ok: false, code: 'unavailable' };
    }
    return { ok: true, models: body.models };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

/** The slice of `SpeechModelManager` the controller uses. */
export interface ModelStore {
  state(modelId: string): Promise<ModelState>;
  ready(modelId: string): Promise<{ model: SpeechModel; dir: string } | null>;
  download(modelId: string): Promise<ModelState>;
  cancel(modelId: string): boolean;
  remove(modelId: string): Promise<ModelState>;
  onState(listener: (state: ModelState) => void): () => void;
  list(): Promise<CatalogModel[]>;
  has(modelId: string): Promise<boolean>;
  registerPack(model: SpeechModel, pluginId: string): Promise<void>;
  folder(): Promise<string>;
  stage(modelId: string): Promise<string>;
  discardStage(modelId: string): Promise<void>;
  commitImport(model: SpeechModel): Promise<ModelState>;
}

/** The native boxes, owned by the main process. */
export interface SpeechDialogs {
  /** The folder of a local import, or null when the user cancelled. */
  pickModelFolder(): Promise<string | null>;
  /** Whether the user accepts to download a plugin's model. */
  confirmPack(model: SpeechModel, pluginId: string): Promise<boolean>;
}

/** The slice of `SpeechEngineHost` the controller uses. */
export interface DictationEngine {
  readonly activeSession: string | null;
  start(init: WorkerInit, interim?: InterimPolicy): Promise<string>;
  feed(sessionId: string, samples: Float32Array): boolean;
  stop(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export type SpeechControllerOptions = {
  models: ModelStore;
  engine: DictationEngine;
  availability: () => EngineAvailability;
  /** Resolved by the main process; null when `availability()` is not 'available'. */
  addonDir: () => string | null;
  numThreads: number;
  /** Without them, no import or pack can start: both need a box the user answers. */
  dialogs?: SpeechDialogs;
  /** Where a pack entry is read from; without it, no pack can be proposed. */
  packs?: PackSource;
  /** Loads `init` once in a disposable process (`probeModel`). */
  probe?: (init: WorkerInit, timeoutMs: number) => Promise<VetResult>;
  log?: (message: string) => void;
};

/**
 * The init of a trial load: no language is chosen yet, so a family that needs
 * one takes the first the entry lists. Null when the init would be refused.
 */
export function workerInitFor(model: SpeechModel, dir: string, addonDir: string, numThreads: number): WorkerInit | null {
  const language = needsLanguage(model.family) ? (model.languages.codes[0] as SpeechLanguage | undefined) ?? null : null;
  const init = workerInit(model, { addonDir, modelDir: dir, language, numThreads });
  return workerInitSchema.safeParse(init).success ? init : null;
}

const UNAVAILABLE = 'Local dictation is not available on this computer.';

/**
 * The engine init for a catalog model: its family, its filter, the options
 * the catalog pinned, and one path per role. `data` files stay out: the graph
 * names them itself.
 */
export function workerInit(
  model: SpeechModel,
  where: { addonDir: string; modelDir: string; language: SpeechLanguage | null; numThreads: number },
): WorkerInit {
  const files: WorkerInit['files'] = {};
  for (const file of model.files) {
    if ((WORKER_FILE_ROLES as readonly string[]).includes(file.role)) files[file.role as WorkerFileRole] = file.path;
  }
  return {
    type: 'init',
    addonDir: where.addonDir,
    modelDir: where.modelDir,
    family: model.family,
    files,
    language: where.language,
    options: { ...model.options },
    filter: model.filter,
    sampleRate: DICTATION_SAMPLE_RATE,
    numThreads: where.numThreads,
  };
}

/** Declines of one plugin after which its proposals stop reaching the box, for the session. */
export const MAX_PACK_DECLINES_PER_PLUGIN = 3;

export class SpeechController {
  private importing = false;
  private confirming = false;
  /**
   * Packs the user declined in this session, and declines per
   * plugin: a renderer may propose again and again, and a box shown ten
   * times gets clicked through. A decline holds until the desktop restarts.
   */
  private readonly declined = new Set<string>();
  private readonly declinesByPlugin = new Map<string, number>();

  constructor(private readonly options: SpeechControllerOptions) {}

  private log(message: string): void {
    (this.options.log ?? ((line: string) => console.warn(line)))(message);
  }

  /** Refuses an id the live catalog does not hold, before it reaches any path. */
  private async known(modelId: string): Promise<string> {
    if (!(await this.options.models.has(modelId))) throw new Error('Unknown speech model.');
    return modelId;
  }

  private addonDir(): string | null {
    return this.options.availability() === 'available' ? this.options.addonDir() : null;
  }

  async state(modelId: string = DEFAULT_SPEECH_MODEL_ID): Promise<SpeechState> {
    return {
      engine: this.options.availability(),
      model: await this.options.models.state(await this.known(modelId)),
      sessionId: this.options.engine.activeSession,
    };
  }

  async listModels(): Promise<ModelListing[]> {
    const entries = await this.options.models.list();
    return Promise.all(entries.map(async ({ model, origin }) => ({
      id: model.id, model, origin, state: await this.options.models.state(model.id),
    })));
  }

  async download(modelId: string = DEFAULT_SPEECH_MODEL_ID): Promise<ModelState> {
    return this.options.models.download(await this.known(modelId));
  }

  async cancelDownload(modelId: string = DEFAULT_SPEECH_MODEL_ID): Promise<boolean> {
    return this.options.models.cancel(await this.known(modelId));
  }

  /** The engine holds the model files open (Windows refuses to delete them): end it first. */
  async deleteModel(modelId: string = DEFAULT_SPEECH_MODEL_ID): Promise<ModelState> {
    const id = await this.known(modelId);
    await this.options.engine.shutdown();
    return this.options.models.remove(id);
  }

  /** The trial load of a model that is not built in, in a process of its own. */
  async probeModel(model: SpeechModel, dir: string): Promise<VetResult> {
    const addonDir = this.addonDir();
    if (!addonDir || !this.options.probe) return { ok: false, message: UNAVAILABLE };
    const init = workerInitFor(model, dir, addonDir, this.options.numThreads);
    if (!init) return { ok: false, message: 'This version of Timon cannot run this kind of model yet.' };
    return this.options.probe(init, probeTimeoutMs(model));
  }

  /** "Add a local model": the main process asks for the folder, then checks and copies it. */
  async importModel(request: ImportRequest = {}): Promise<ImportResult> {
    if (this.importing) return { ok: false, code: 'busy', message: 'A model is already being imported.' };
    const dialogs = this.options.dialogs;
    if (!this.addonDir() || !dialogs || !this.options.probe) return { ok: false, code: 'engine-unavailable', message: UNAVAILABLE };
    this.importing = true;
    try {
      const source = await dialogs.pickModelFolder();
      if (!source) return { ok: false, code: 'cancelled', message: 'No folder was chosen.' };
      const { model, state } = await importModelFolder(source, request, {
        manager: this.options.models,
        modelsDir: () => this.options.models.folder(),
        runnable: () => true,
        probe: (candidate, dir) => this.probeModel(candidate, dir),
      });
      return { ok: true, model, state };
    } catch (error) {
      if (error instanceof ImportRefused) return { ok: false, code: error.code, message: error.message, ...error.detail };
      // Never the raw error: it may carry a path of the user's disk.
      this.log(`[speech] model import failed: ${(error as Error)?.name ?? 'error'}`);
      return { ok: false, code: 'io', message: 'The model could not be imported.' };
    } finally {
      this.importing = false;
    }
  }

  /**
   * An entry of an installed plugin's pack (vault note §2.2, TODO #584). The
   * renderer names it; the entry itself is read from the daemon, which serves
   * the file of the plugin's package under that plugin's id: a page of the
   * shared realm can ask for another plugin's entry, never write one under
   * its name. Parsed, pinned to Hugging Face and to its plugin's id, then
   * shown in a native box; only an accepted entry joins the catalog, and its
   * download is vetted before ready.
   */
  async proposePack(pluginId: string, modelId: string): Promise<PackResult> {
    if (!modelId.startsWith(`${pluginId}.`)) return { ok: false, code: 'invalid', message: 'A plugin model id starts with its plugin id.' };
    if (this.declined.has(modelId) || (this.declinesByPlugin.get(pluginId) ?? 0) >= MAX_PACK_DECLINES_PER_PLUGIN) {
      return { ok: false, code: 'declined', message: 'The download was already declined.' };
    }
    if (await this.options.models.has(modelId)) return { ok: false, code: 'exists', message: 'This model is already in the catalog.' };
    const dialogs = this.options.dialogs;
    if (!this.addonDir() || !dialogs) return { ok: false, code: 'engine-unavailable', message: UNAVAILABLE };
    if (this.confirming) return { ok: false, code: 'busy', message: 'Another model is waiting for your answer.' };
    this.confirming = true;
    try {
      const pack = this.options.packs ? await this.options.packs(pluginId) : { ok: false as const, code: 'unavailable' as const };
      if (!pack.ok) {
        return pack.code === 'not-found'
          ? { ok: false, code: 'not-found', message: 'No active plugin offers this model.' }
          : { ok: false, code: 'unavailable', message: 'The plugin\'s models could not be read from Timon.' };
      }
      const input = pack.models.find((entry) => entry !== null && typeof entry === 'object' && (entry as { id?: unknown }).id === modelId);
      if (input === undefined) return { ok: false, code: 'not-found', message: 'No active plugin offers this model.' };
      const parsed = parseSpeechModel(input);
      if (!parsed.ok) {
        return parsed.reason === 'unknown-family'
          ? { ok: false, code: 'unknown-family', message: 'This model needs a newer version of Timon.', issues: parsed.issues.slice(0, 5) }
          : { ok: false, code: 'invalid', message: 'This model entry is not valid.', issues: parsed.issues.slice(0, 5) };
      }
      const model = parsed.model;
      if (model.source.kind !== 'huggingface') return { ok: false, code: 'invalid', message: 'A plugin model downloads from Hugging Face.' };
      if (model.license.redistribution !== 'ok') return { ok: false, code: 'invalid', message: 'This model may not be redistributed.' };
      if (!(await dialogs.confirmPack(model, pluginId))) {
        this.declined.add(model.id);
        this.declinesByPlugin.set(pluginId, (this.declinesByPlugin.get(pluginId) ?? 0) + 1);
        return { ok: false, code: 'declined', message: 'The download was declined.' };
      }
      await this.options.models.registerPack(model, pluginId);
      return { ok: true, modelId: model.id, state: await this.options.models.state(model.id) };
    } finally {
      this.confirming = false;
    }
  }

  /**
   * The model and imposed language for a dictation. A chosen model that can
   * take the language runs with it (a detecting one always does); otherwise,
   * or with no model chosen, the catalog decides among the installed models:
   * a model that imposes the language first, else one that detects it
   * (Parakeet). Null when nothing installed fits.
   */
  async resolve(modelId: string | undefined, language: string | undefined): Promise<ResolvedModel | null> {
    const catalog = (await this.options.models.list()).map((entry) => entry.model);
    const code = primaryLanguage(language);
    const chosen = modelId ? speechModel(modelId, catalog) : null;
    if (chosen) {
      if (chosen.languages.mode === 'auto') return { model: chosen, language: null };
      if (code && chosen.languages.codes.includes(code)) return { model: chosen, language: code };
    }
    const states = await Promise.all(catalog.map((model) => this.options.models.state(model.id)));
    const installed = new Set(states.filter((state) => state.status === 'ready').map((state) => state.modelId));
    return resolveModel(code, { catalog, usable: (model) => installed.has(model.id) });
  }

  async start(modelId?: string, language?: string, interim?: InterimChoice): Promise<StartResult> {
    const addonDir = this.addonDir();
    if (!addonDir) return { ok: false, code: 'engine-unavailable', message: UNAVAILABLE };
    if (modelId) await this.known(modelId);
    const resolved = await this.resolve(modelId, language);
    const ready = resolved ? await this.options.models.ready(resolved.model.id) : null;
    if (!resolved || !ready) return { ok: false, code: 'model-missing', message: 'Download the speech model first.' };
    const init = workerInit(ready.model, { addonDir, modelDir: ready.dir, language: resolved.language, numThreads: this.options.numThreads });
    // The worker drops an init it refuses, and the session would wait for the
    // load timeout: refuse it here, at once. The catalog schema already bars it.
    if (!workerInitSchema.safeParse(init).success) {
      return { ok: false, code: 'engine-unavailable', message: 'This speech model cannot dictate in this language.' };
    }
    const policy = interimPolicy(ready.model.interim, { user: interim, languageDetected: resolved.language === null });
    try {
      const sessionId = await this.options.engine.start(init, policy);
      return { ok: true, sessionId, modelId: ready.model.id, language: resolved.language, interim: policy.mode };
    } catch (error) {
      const code = error instanceof EngineError ? error.code : 'init-failed';
      return { ok: false, code, message: error instanceof EngineError ? error.message : 'The dictation engine could not start.' };
    }
  }

  feed(sessionId: string, samples: Float32Array): boolean {
    return this.options.engine.feed(sessionId, samples);
  }

  stop(sessionId: string): Promise<void> {
    return this.options.engine.stop(sessionId);
  }

  cancel(sessionId: string): Promise<void> {
    return this.options.engine.cancel(sessionId);
  }
}

/** What the sender check reads from an IPC event (same shape as `canReadAppInfo`). */
export type SenderEvent = { isWindow: boolean; isMainFrame: boolean; url: string };

/** `ipcMain`, with each event already reduced to its sender; a fake in tests. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: SenderEvent, input: unknown) => unknown): void;
  on(channel: string, listener: (event: SenderEvent, input: unknown) => void): void;
}

export function registerSpeechIpc(ipc: IpcMainLike, isTrusted: (event: SenderEvent) => boolean, controller: () => SpeechController): void {
  const guard = (event: SenderEvent): void => {
    if (!isTrusted(event)) throw new Error('Dictation is only available in the Timon window.');
  };
  ipc.handle(SPEECH_CHANNELS.state, (event, input) => {
    guard(event);
    return controller().state(modelRequestSchema.parse(input)?.modelId);
  });
  ipc.handle(SPEECH_CHANNELS.download, (event, input) => {
    guard(event);
    return controller().download(modelRequestSchema.parse(input)?.modelId);
  });
  ipc.handle(SPEECH_CHANNELS.cancelDownload, (event, input) => {
    guard(event);
    return controller().cancelDownload(modelRequestSchema.parse(input)?.modelId);
  });
  ipc.handle(SPEECH_CHANNELS.deleteModel, (event, input) => {
    guard(event);
    return controller().deleteModel(modelRequestSchema.parse(input)?.modelId);
  });
  ipc.handle(SPEECH_CHANNELS.start, (event, input) => {
    guard(event);
    const request = startRequestSchema.parse(input);
    return controller().start(request?.modelId, request?.language, request?.interim);
  });
  ipc.handle(SPEECH_CHANNELS.listModels, (event, input) => {
    guard(event);
    z.undefined().parse(input);
    return controller().listModels();
  });
  ipc.handle(SPEECH_CHANNELS.importModel, (event, input) => {
    guard(event);
    return controller().importModel(importRequestSchema.parse(input) ?? {});
  });
  ipc.handle(SPEECH_CHANNELS.proposePack, (event, input) => {
    guard(event);
    const request = packRequestSchema.parse(input);
    return controller().proposePack(request.pluginId, request.modelId);
  });
  ipc.handle(SPEECH_CHANNELS.stop, (event, input) => {
    guard(event);
    return controller().stop(sessionRequestSchema.parse(input).sessionId);
  });
  ipc.handle(SPEECH_CHANNELS.cancel, (event, input) => {
    guard(event);
    return controller().cancel(sessionRequestSchema.parse(input).sessionId);
  });
  // Fire-and-forget: ~10 chunks a second, an invoke round trip each would be waste.
  ipc.on(SPEECH_CHANNELS.feed, (event, input) => {
    if (!isTrusted(event)) return;
    const parsed = feedRequestSchema.safeParse(input);
    if (parsed.success) controller().feed(parsed.data.sessionId, parsed.data.samples);
  });
}

/**
 * The microphone gate, for the dictation UI: whether to explain a blocked
 * microphone (System Settings, Windows privacy) before it captures. Asking
 * here is optional: the permission handler asks too, on the first capture.
 */
export function registerMicrophoneIpc(ipc: IpcMainLike, isTrusted: (event: SenderEvent) => boolean, access: MicrophoneAccess): void {
  ipc.handle(SPEECH_CHANNELS.microphone, async (event, input): Promise<{ status: MicrophoneStatus }> => {
    if (!isTrusted(event)) throw new Error('Dictation is only available in the Timon window.');
    const request = microphoneRequestSchema.parse(input)?.request === true;
    return { status: request ? await access.ensure() : access.status() };
  });
}
