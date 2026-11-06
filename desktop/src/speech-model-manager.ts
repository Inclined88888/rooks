import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BUILTIN_SPEECH_MODELS, speechModel } from './speech-catalog/builtin.js';
import {
  modelFileUrl, modelSize, pathSegments, speechCatalogSchema, speechModelSchema, type SpeechModel, type SpeechModelFile,
} from './speech-catalog/schema.js';

/**
 * Downloads, verifies and removes the dictation models (TODO #443).
 *
 * Layout under the models directory (a file path may hold one folder level):
 *   <id>.partial/<path>.part   bytes still arriving (kept across a cut or a cancel)
 *   <id>.partial/<path>        a file whose size and sha256 were verified
 *   <id>/                      the complete model, moved there in one rename
 *   <id>/model.json            written last, after every hash matched
 *
 * `ready` is derived from `model.json` matching the catalog (family, revision
 * and hashes), never from a cached flag: an update of the catalog invalidates
 * an old model by itself.
 *
 * `model.json` is version 2 since TODO #484 (family, source, role and path of
 * each file). A version 1 marker, written by #443 for Parakeet, still counts
 * when it matches the catalog: nothing is downloaded again, and the marker is
 * rewritten as version 2 the next time the engine asks for the model.
 *
 * Cancel keeps the `.part` files so the next download resumes with an HTTP
 * Range; delete removes everything.
 *
 * The catalog is live (TODO #484, A3): the built-in entries, the packs a
 * plugin proposed and the user confirmed, and the local imports. A model
 * that is not built in carries its own entry and origin in its marker, so it
 * is found again after a restart. It is never trusted on its download alone:
 * its graphs are inspected and a disposable process loads it once before it
 * becomes ready, and the graphs are inspected again the first time a session
 * loads it.
 */

export type ModelStatus = 'absent' | 'partial' | 'downloading' | 'verifying' | 'ready' | 'error';
/** `rejected`: the files arrived intact but are not a model this desktop will load. */
export type ModelErrorCode = 'network' | 'http' | 'stalled' | 'integrity' | 'disk-full' | 'io' | 'rejected';

export type ModelState = {
  modelId: string;
  status: ModelStatus;
  receivedBytes: number;
  totalBytes: number;
  error: ModelErrorCode | null;
};

export type ReadyModel = { model: SpeechModel; dir: string };

/** Where an entry of the live catalog comes from. */
export type ModelOrigin = { kind: 'builtin' } | { kind: 'pack'; pluginId: string } | { kind: 'local' };
export type CatalogModel = { model: SpeechModel; origin: ModelOrigin };

export type VetResult = { ok: true } | { ok: false; message: string };

/** The checks a model that is not built in passes before the engine may load it. */
export type ModelVetting = {
  /** Reads the graphs (`speech-onnx-inspect.ts`): after a download, and before each session's first load. */
  inspect(model: SpeechModel, dir: string): Promise<VetResult>;
  /** Loads the model once in a disposable process: after a download. */
  probe(model: SpeechModel, dir: string): Promise<VetResult>;
};

/** A plugin id (`manifest.ts`); a pack's model id starts with it and a dot. */
export const PLUGIN_ID = /^[a-z0-9-]{3,40}$/;

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export type ModelManagerOptions = {
  /**
   * The models directory, or a function that prepares it on first use (the
   * shared Windows folder is checked asynchronously, TODO #445). A failed
   * preparation is retried on the next call.
   */
  modelsDir: string | (() => Promise<string>);
  /**
   * Re-hash the files once per session before the engine first loads them.
   * Defense in depth for a folder outside the home; off by default, because
   * reading 670 MB delays the first dictation by seconds.
   */
  verifyOnLoad?: boolean;
  fetch: FetchLike;
  /** Free bytes on the volume of `dir`, or null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** The built-in entries, parsed again here: a bad entry fails the constructor, not a download. */
  catalog?: readonly SpeechModel[];
  /** Without it, no pack or import ever becomes ready: the checks fail closed. */
  vetting?: ModelVetting;
  /** A download with no byte for this long is aborted (`stalled`). */
  stallMs?: number;
  /** Minimum interval between two progress notifications. */
  progressIntervalMs?: number;
  log?: (message: string) => void;
};

const MARKER = 'model.json';
const MARKER_VERSION = 2;

/** Which marker made a model ready: a `1` is rewritten as the current version. */
type MarkerMatch = 1 | typeof MARKER_VERSION;

/** Where `file` lives in `dir`: segments joined by the OS, never a "/" handed to it. */
function filePath(dir: string, file: SpeechModelFile): string {
  return join(dir, ...pathSegments(file));
}

/** The marker's `path → sha256` map, from `files[].<key>`; null when malformed. */
function recordedHashes(files: unknown, key: 'path' | 'name'): Map<string, string> | null {
  if (!Array.isArray(files)) return null;
  const recorded = new Map<string, string>();
  for (const entry of files as unknown[]) {
    if (entry && typeof entry === 'object') {
      const path = (entry as Record<string, unknown>)[key];
      const sha256 = (entry as Record<string, unknown>).sha256;
      if (typeof path === 'string' && typeof sha256 === 'string') recorded.set(path, sha256);
    }
  }
  return recorded;
}

/** The entry and origin a marker records for a model that is not built in, or null. */
function installedEntry(marker: Record<string, unknown>, dirName: string): CatalogModel | null {
  if (marker.version !== MARKER_VERSION) return null;
  const parsed = speechModelSchema.safeParse(marker.entry);
  if (!parsed.success || parsed.data.id !== dirName) return null;
  const model = parsed.data;
  const origin = marker.origin as { kind?: unknown; pluginId?: unknown } | null | undefined;
  if (origin?.kind === 'local' && model.source.kind === 'local') return { model, origin: { kind: 'local' } };
  if (origin?.kind === 'pack' && model.source.kind === 'huggingface'
    && typeof origin.pluginId === 'string' && PLUGIN_ID.test(origin.pluginId) && model.id.startsWith(`${origin.pluginId}.`)) {
    return { model, origin: { kind: 'pack', pluginId: origin.pluginId } };
  }
  return null;
}

function revisionOf(model: SpeechModel): string | null {
  return model.source.kind === 'huggingface' ? model.source.revision : null;
}

/** Room left on the disk after the model, so the download never fills it. */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;

class DownloadError extends Error {
  constructor(readonly code: ModelErrorCode, message: string) {
    super(message);
  }
}

/** Abort reason of a user cancel: not an error, the part files stay. */
class CancelledError extends Error {}

type Active = {
  controller: AbortController;
  state: ModelState;
  /** Set synchronously right after the entry is registered. */
  promise: Promise<ModelState> | null;
};

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

function writeChunk(out: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function closeStream(out: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    out.once('error', reject);
    out.end(() => resolve());
  });
}

export class SpeechModelManager {
  private readonly resolveDir: () => Promise<string>;
  private dirPromise: Promise<string> | null = null;
  private readonly verifyOnLoad: boolean;
  /** Models whose hashes were checked by `ready` in this session. */
  private readonly verified = new Set<string>();
  private readonly fetchImpl: FetchLike;
  private readonly freeBytes: (dir: string) => Promise<number | null>;
  private readonly catalog: readonly SpeechModel[];
  /** Packs and imports, by id; never a built-in id. */
  private readonly extras = new Map<string, CatalogModel>();
  private installed: Promise<void> | null = null;
  private readonly vetting: ModelVetting | null;
  /** Extras whose graphs were inspected in this session. */
  private readonly inspected = new Set<string>();
  private readonly stallMs: number;
  private readonly progressIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly active = new Map<string, Active>();
  private readonly lastError = new Map<string, ModelErrorCode>();
  private readonly listeners = new Set<(state: ModelState) => void>();

  constructor(options: ModelManagerOptions) {
    const { modelsDir } = options;
    this.resolveDir = typeof modelsDir === 'string' ? async () => modelsDir : modelsDir;
    this.verifyOnLoad = options.verifyOnLoad ?? false;
    this.fetchImpl = options.fetch;
    this.freeBytes = options.freeBytes ?? defaultFreeBytes;
    this.catalog = speechCatalogSchema.parse(options.catalog ?? BUILTIN_SPEECH_MODELS);
    this.vetting = options.vetting ?? null;
    this.stallMs = options.stallMs ?? 60_000;
    this.progressIntervalMs = options.progressIntervalMs ?? 250;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** Returns an unsubscribe function. */
  onState(listener: (state: ModelState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(state: ModelState): void {
    for (const listener of this.listeners) {
      try { listener({ ...state }); } catch (error) { this.log(`[speech] state listener failed: ${(error as Error).message}`); }
    }
  }

  private entry(modelId: string): CatalogModel | null {
    const builtin = speechModel(modelId, this.catalog);
    if (builtin) return { model: builtin, origin: { kind: 'builtin' } };
    return this.extras.get(modelId) ?? null;
  }

  private model(modelId: string): SpeechModel {
    const found = this.entry(modelId);
    if (!found) throw new Error('Unknown speech model.');
    return found.model;
  }

  private isBuiltin(modelId: string): boolean {
    return speechModel(modelId, this.catalog) !== null;
  }

  /** Finds the packs and imports installed by an earlier session, once (again after a failure). */
  private loadInstalled(): Promise<void> {
    if (!this.installed) {
      const pending = this.scanInstalled();
      this.installed = pending;
      pending.catch((error: unknown) => {
        this.log(`[speech] could not list the installed models: ${(error as Error)?.name ?? 'error'}`);
        if (this.installed === pending) this.installed = null;
      });
    }
    return this.installed.catch(() => undefined);
  }

  private async scanInstalled(): Promise<void> {
    const dir = await this.modelsDir();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // A link is not a directory here: a model folder is always a real one.
      if (!entry.isDirectory() || entry.name.endsWith('.partial') || this.isBuiltin(entry.name) || this.extras.has(entry.name)) continue;
      let marker: unknown;
      try {
        marker = JSON.parse(await readFile(join(dir, entry.name, MARKER), 'utf8'));
      } catch {
        continue;
      }
      const installed = marker && typeof marker === 'object' ? installedEntry(marker as Record<string, unknown>, entry.name) : null;
      if (installed) this.extras.set(installed.model.id, installed);
      else this.log(`[speech] ignoring the models folder entry ${JSON.stringify(entry.name.slice(0, 80))}: no valid marker`);
    }
  }

  /** Every model of the live catalog: built-in first, in catalog order, then packs and imports. */
  async list(): Promise<CatalogModel[]> {
    await this.loadInstalled();
    return [
      ...this.catalog.map((model): CatalogModel => ({ model, origin: { kind: 'builtin' } })),
      ...[...this.extras.values()].sort((a, b) => a.model.id.localeCompare(b.model.id)),
    ];
  }

  async has(modelId: string): Promise<boolean> {
    await this.loadInstalled();
    return this.entry(modelId) !== null;
  }

  /**
   * Adds a plugin's model, confirmed by the user, so it can be downloaded.
   * Kept in memory until its download completes; its marker then records it.
   */
  async registerPack(model: SpeechModel, pluginId: string): Promise<void> {
    const parsed = speechModelSchema.parse(model);
    if (!PLUGIN_ID.test(pluginId) || !parsed.id.startsWith(`${pluginId}.`)) throw new Error('A pack model id starts with its plugin id.');
    if (parsed.source.kind !== 'huggingface' || parsed.license.redistribution !== 'ok') throw new Error('This speech model cannot be downloaded.');
    if (await this.has(parsed.id)) throw new Error('This speech model is already in the catalog.');
    this.extras.set(parsed.id, { model: parsed, origin: { kind: 'pack', pluginId } });
  }

  /** An empty staging folder for an import of `modelId`, which must not exist yet. */
  async stage(modelId: string): Promise<string> {
    if (!modelId.startsWith('custom-') || (await this.has(modelId))) throw new Error('This speech model id is taken.');
    const dir = join(await this.modelsDir(), `${modelId}.partial`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async discardStage(modelId: string): Promise<void> {
    if (!modelId.startsWith('custom-')) return;
    await rm(join(await this.modelsDir(), `${modelId}.partial`), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  /**
   * Installs an import whose files the caller copied into `stage(model.id)`,
   * hashed, inspected and loaded once: writes its marker, moves the folder in
   * place and adds the model to the catalog, ready.
   */
  async commitImport(model: SpeechModel): Promise<ModelState> {
    const parsed = speechModelSchema.parse(model);
    if (parsed.source.kind !== 'local') throw new Error('Only a local import is committed this way.');
    if (await this.has(parsed.id)) throw new Error('This speech model id is taken.');
    const staging = join(await this.modelsDir(), `${parsed.id}.partial`);
    for (const file of parsed.files) {
      if ((await sizeOf(filePath(staging, file))) !== file.sizeBytes) throw new Error(`${file.path} is missing from the staged import.`);
    }
    const origin: ModelOrigin = { kind: 'local' };
    await writeFile(join(staging, MARKER), this.markerFor(parsed, new Date().toISOString(), origin));
    const final = join(await this.modelsDir(), parsed.id);
    await rm(final, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rename(staging, final);
    this.extras.set(parsed.id, { model: parsed, origin });
    // Inspected by the import a moment ago, in the folder only we write to.
    this.inspected.add(parsed.id);
    this.verified.add(parsed.id);
    const state = await this.state(parsed.id);
    this.emit(state);
    return state;
  }

  /** Inspection, then the trial load; fails closed without vetting. */
  private async vet(model: SpeechModel, dir: string): Promise<VetResult> {
    if (!this.vetting) return { ok: false, message: 'This desktop cannot check a speech model that is not built in.' };
    const inspected = await this.vetting.inspect(model, dir);
    if (!inspected.ok) return inspected;
    return this.vetting.probe(model, dir);
  }

  private modelsDir(): Promise<string> {
    if (!this.dirPromise) {
      const pending = this.resolveDir();
      this.dirPromise = pending;
      pending.catch(() => { if (this.dirPromise === pending) this.dirPromise = null; });
    }
    return this.dirPromise;
  }

  /** The models folder, prepared on first use. */
  folder(): Promise<string> {
    return this.modelsDir();
  }

  private async finalDir(model: SpeechModel): Promise<string> { return join(await this.modelsDir(), model.id); }
  private async stagingDir(model: SpeechModel): Promise<string> { return join(await this.modelsDir(), `${model.id}.partial`); }

  /** The marker version that makes the model ready, or null when it is not. */
  private async isComplete(model: SpeechModel): Promise<MarkerMatch | null> {
    const dir = await this.finalDir(model);
    let marker: unknown;
    try {
      marker = JSON.parse(await readFile(join(dir, MARKER), 'utf8'));
    } catch {
      return null;
    }
    if (!marker || typeof marker !== 'object') return null;
    const m = marker as Record<string, unknown>;
    let match: MarkerMatch;
    let recorded: Map<string, string> | null;
    if (m.version === MARKER_VERSION) {
      if (m.family !== model.family || m.revision !== revisionOf(model)) return null;
      recorded = recordedHashes(m.files, 'path');
      match = MARKER_VERSION;
    } else if (m.version === 1) {
      // Version 1 only ever described a downloaded model, by bare file names.
      if (model.source.kind !== 'huggingface' || m.revision !== model.source.revision) return null;
      recorded = recordedHashes(m.files, 'name');
      match = 1;
    } else {
      return null;
    }
    if (!recorded) return null;
    for (const file of model.files) {
      if (recorded.get(file.path) !== file.sha256) return null;
      // Size only: the hash was checked before the marker was written, and
      // re-hashing 670 MB on every state read would freeze the settings page.
      if ((await sizeOf(filePath(dir, file))) !== file.sizeBytes) return null;
    }
    return match;
  }

  private markerFor(model: SpeechModel, installedAt: string, origin: ModelOrigin): string {
    // An entry not built in is found again only through its own marker.
    const extra = origin.kind === 'builtin' ? {} : { origin, entry: model };
    return `${JSON.stringify({
      version: MARKER_VERSION,
      modelId: model.id,
      family: model.family,
      source: model.source,
      revision: revisionOf(model),
      files: model.files.map(({ role, path, sizeBytes, sha256 }) => ({ role, path, sizeBytes, sha256 })),
      installedAt,
      // Pinned by the catalog and hashed against it; a local import says false.
      verified: model.source.kind !== 'local',
      ...extra,
    }, null, 2)}\n`;
  }

  /**
   * A version 1 marker becomes version 2, through a temporary file and a
   * rename so a crash never leaves half a marker. Best effort: the model is
   * ready either way, the next call tries again.
   */
  private async upgradeMarker(model: SpeechModel, dir: string): Promise<void> {
    try {
      const previous = JSON.parse(await readFile(join(dir, MARKER), 'utf8')) as { verifiedAt?: unknown };
      const installedAt = typeof previous.verifiedAt === 'string' ? previous.verifiedAt : new Date().toISOString();
      const temporary = join(dir, `${MARKER}.tmp`);
      await writeFile(temporary, this.markerFor(model, installedAt, { kind: 'builtin' }));
      await rename(temporary, join(dir, MARKER));
    } catch (error) {
      this.log(`[speech] could not rewrite the marker of ${model.id}: ${(error as Error)?.name ?? 'error'}`);
    }
  }

  private async stagedBytes(model: SpeechModel): Promise<{ bytes: number; any: boolean }> {
    const dir = await this.stagingDir(model);
    let bytes = 0;
    let any = false;
    for (const file of model.files) {
      const done = await sizeOf(filePath(dir, file));
      if (done === file.sizeBytes) { bytes += done; any = true; continue; }
      const part = await sizeOf(`${filePath(dir, file)}.part`);
      if (part !== null) { bytes += Math.min(part, file.sizeBytes); any = true; }
    }
    return { bytes, any };
  }

  async state(modelId: string): Promise<ModelState> {
    // The folder first: listing the installed models must not spend its retry.
    let folderError: unknown = null;
    try {
      await this.modelsDir();
      await this.loadInstalled();
    } catch (error) {
      folderError = error ?? new Error('error');
    }
    const model = this.model(modelId);
    const running = this.active.get(model.id);
    if (running) return { ...running.state };
    const totalBytes = modelSize(model);
    if (folderError) {
      this.log(`[speech] no usable models folder: ${(folderError as Error)?.message ?? 'error'}`);
      return { modelId: model.id, status: 'error', receivedBytes: 0, totalBytes, error: 'io' };
    }
    // A model refused by the inspection at load stays refused until it is removed.
    if (this.lastError.get(model.id) !== 'rejected' && (await this.isComplete(model)) !== null) {
      return { modelId: model.id, status: 'ready', receivedBytes: totalBytes, totalBytes, error: null };
    }
    const staged = await this.stagedBytes(model);
    const error = this.lastError.get(model.id) ?? null;
    return {
      modelId: model.id,
      status: error ? 'error' : staged.any ? 'partial' : 'absent',
      receivedBytes: staged.bytes,
      totalBytes,
      error,
    };
  }

  /** The verified model directory, or null when the model is not ready. */
  async ready(modelId: string): Promise<ReadyModel | null> {
    try {
      await this.modelsDir();
    } catch {
      return null;
    }
    await this.loadInstalled();
    const model = this.model(modelId);
    if (this.active.has(model.id)) return null;
    const match = await this.isComplete(model);
    if (match === null) return null;
    const dir = await this.finalDir(model);
    if (this.verifyOnLoad && !this.verified.has(model.id)) {
      for (const file of model.files) {
        if ((await sha256Of(filePath(dir, file)).catch(() => null)) !== file.sha256) {
          this.log(`[speech] ${model.id}/${file.path} does not match its checksum: deleting the model`);
          await this.remove(model.id);
          return null;
        }
      }
      this.verified.add(model.id);
    }
    // The folder may have changed since the last session: the graphs are read again before the addon sees them.
    if (!this.isBuiltin(model.id) && !this.inspected.has(model.id)) {
      const verdict = this.vetting ? await this.vetting.inspect(model, dir) : { ok: false as const, message: 'no vetting' };
      if (!verdict.ok) {
        this.log(`[speech] ${model.id} was refused at load: ${verdict.message}`);
        this.lastError.set(model.id, 'rejected');
        this.emit(await this.state(model.id));
        return null;
      }
      this.inspected.add(model.id);
    }
    if (match !== MARKER_VERSION) await this.upgradeMarker(model, dir);
    return { model, dir };
  }

  isDownloading(modelId: string): boolean {
    return this.active.has(modelId);
  }

  /**
   * Starts (or joins) the download; resolves with the state it ended in.
   * Throws for a model with nothing to fetch (a local import) or whose
   * licence does not say it may be redistributed.
   */
  download(modelId: string): Promise<ModelState> {
    const model = this.model(modelId);
    if (model.source.kind !== 'huggingface' || model.license.redistribution !== 'ok') {
      throw new Error('This speech model cannot be downloaded.');
    }
    const running = this.active.get(model.id);
    if (running?.promise) return running.promise;
    const entry: Active = {
      controller: new AbortController(),
      state: { modelId: model.id, status: 'downloading', receivedBytes: 0, totalBytes: modelSize(model), error: null },
      promise: null,
    };
    this.active.set(model.id, entry);
    this.lastError.delete(model.id);
    const promise = this.run(model, entry).finally(() => { this.active.delete(model.id); });
    entry.promise = promise;
    return promise;
  }

  /** Stops every download (app quit). */
  cancelAll(): void {
    for (const running of this.active.values()) running.controller.abort(new CancelledError('cancelled'));
  }

  /** Stops a running download and keeps what arrived. False when none was running. */
  cancel(modelId: string): boolean {
    const running = this.active.get(modelId);
    if (!running) return false;
    running.controller.abort(new CancelledError('cancelled'));
    return true;
  }

  /**
   * Cancels any download, then deletes the model and its partial files. A
   * pack or an import also leaves the catalog.
   */
  async remove(modelId: string): Promise<ModelState> {
    await this.loadInstalled();
    const model = this.model(modelId);
    const running = this.active.get(model.id);
    if (running) {
      running.controller.abort(new CancelledError('cancelled'));
      await running.promise?.catch(() => undefined);
    }
    // `maxRetries` covers EBUSY/EPERM from an antivirus or indexer still
    // holding a file on Windows; the engine is stopped by the caller first.
    const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;
    this.verified.delete(model.id);
    this.inspected.delete(model.id);
    await rm(await this.finalDir(model), options);
    await rm(await this.stagingDir(model), options);
    this.lastError.delete(model.id);
    let state: ModelState;
    if (this.isBuiltin(model.id)) {
      state = await this.state(model.id);
    } else {
      this.extras.delete(model.id);
      state = { modelId: model.id, status: 'absent', receivedBytes: 0, totalBytes: modelSize(model), error: null };
    }
    this.emit(state);
    return state;
  }

  private async run(model: SpeechModel, entry: Active): Promise<ModelState> {
    const { signal } = entry.controller;
    let lastEmit = 0;
    const progress = (receivedBytes: number, force = false): void => {
      entry.state = { ...entry.state, receivedBytes };
      const now = Date.now();
      if (force || now - lastEmit >= this.progressIntervalMs) {
        lastEmit = now;
        this.emit(entry.state);
      }
    };
    const setStatus = (status: ModelStatus): void => {
      entry.state = { ...entry.state, status };
      this.emit(entry.state);
    };

    try {
      // A pack is never taken as installed on a marker it did not write in this run: it is vetted again.
      if (this.isBuiltin(model.id) && (await this.isComplete(model)) !== null) {
        entry.state = { ...entry.state, status: 'ready', receivedBytes: entry.state.totalBytes };
        this.emit(entry.state);
        return { ...entry.state };
      }
      const staging = await this.stagingDir(model);
      await mkdir(staging, { recursive: true });
      const staged = await this.stagedBytes(model);
      progress(staged.bytes, true);

      const free = await this.freeBytes(await this.modelsDir());
      if (free !== null && free < entry.state.totalBytes - staged.bytes + DISK_MARGIN_BYTES) {
        throw new DownloadError('disk-full', 'Not enough free disk space for the speech model.');
      }

      let doneBefore = 0;
      for (const file of model.files) {
        const target = filePath(staging, file);
        if ((await sizeOf(target)) !== file.sizeBytes) {
          await this.fetchFile(model, file, staging, signal, (bytes) => progress(doneBefore + bytes), setStatus);
        }
        doneBefore += file.sizeBytes;
        progress(doneBefore, true);
      }

      const origin = this.entry(model.id)?.origin ?? { kind: 'builtin' };
      if (origin.kind !== 'builtin') {
        // The pinned sha256 proves the bytes are the author's, not that they are safe.
        setStatus('verifying');
        const verdict = await this.vet(model, staging);
        if (!verdict.ok) {
          await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          throw new DownloadError('rejected', `${model.id} was refused after its download: ${verdict.message}`);
        }
      }
      await writeFile(join(staging, MARKER), this.markerFor(model, new Date().toISOString(), origin));
      const final = await this.finalDir(model);
      await rm(final, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await rename(staging, final);
      // Every file was hashed (and a pack inspected) a moment ago, in the folder only we can write to.
      this.verified.add(model.id);
      if (origin.kind !== 'builtin') this.inspected.add(model.id);
      entry.state = { ...entry.state, status: 'ready', receivedBytes: entry.state.totalBytes, error: null };
      this.emit(entry.state);
      return { ...entry.state };
    } catch (error) {
      const staged = await this.stagedBytes(model).catch(() => ({ bytes: 0, any: false }));
      const reason: unknown = signal.aborted ? signal.reason : error;
      if (reason instanceof CancelledError) {
        entry.state = { ...entry.state, status: staged.any ? 'partial' : 'absent', receivedBytes: staged.bytes, error: null };
      } else {
        const code = reason instanceof DownloadError ? reason.code : 'io';
        // Never the raw error text: a redirect URL can carry a signed query.
        this.log(`[speech] model download failed (${code}): ${reason instanceof DownloadError ? reason.message : (reason as Error)?.name ?? 'error'}`);
        this.lastError.set(model.id, code);
        entry.state = { ...entry.state, status: 'error', receivedBytes: staged.bytes, error: code };
      }
      this.emit(entry.state);
      return { ...entry.state };
    }
  }

  /**
   * One file into `<path>.part`, resumed with a Range when bytes are already
   * there, then verified and renamed. A resumed file whose hash does not
   * match is downloaded once more from zero: the old bytes may come from a
   * different revision or a truncated write, the new ones decide.
   */
  private async fetchFile(
    model: SpeechModel,
    file: SpeechModelFile,
    staging: string,
    signal: AbortSignal,
    onBytes: (bytes: number) => void,
    setStatus: (status: ModelStatus) => void,
  ): Promise<void> {
    const target = filePath(staging, file);
    const part = `${target}.part`;
    await mkdir(dirname(part), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let offset = (await sizeOf(part)) ?? 0;
      if (offset > file.sizeBytes) {
        await rm(part, { force: true });
        offset = 0;
      }
      if (offset < file.sizeBytes) {
        offset = await this.transfer(model, file, part, offset, signal, onBytes);
      }
      onBytes(offset);
      // A body that ended early keeps its bytes: the next attempt resumes.
      if ((await sizeOf(part)) !== file.sizeBytes) {
        throw new DownloadError('network', `The connection ended before ${file.path} was complete.`);
      }
      setStatus('verifying');
      const hash = await sha256Of(part);
      setStatus('downloading');
      if (hash === file.sha256) {
        await rename(part, target);
        return;
      }
      await rm(part, { force: true });
      if (signal.aborted) throw signal.reason;
    }
    throw new DownloadError('integrity', `The downloaded ${file.path} does not match its expected checksum.`);
  }

  /** Returns the number of bytes now in `part`. */
  private async transfer(
    model: SpeechModel,
    file: SpeechModelFile,
    part: string,
    offset: number,
    signal: AbortSignal,
    onBytes: (bytes: number) => void,
  ): Promise<number> {
    const local = new AbortController();
    const forward = (): void => local.abort(signal.reason);
    if (signal.aborted) throw signal.reason;
    signal.addEventListener('abort', forward, { once: true });
    let stallTimer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => local.abort(new DownloadError('stalled', 'The model download stalled.')), this.stallMs);
    };
    let out: WriteStream | null = null;
    try {
      arm();
      const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
      const url = modelFileUrl(model, file);
      if (!url) throw new DownloadError('http', `${file.path} has no download source.`);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { headers, signal: local.signal });
      } catch {
        if (local.signal.aborted) throw local.signal.reason;
        throw new DownloadError('network', `Network error while downloading ${file.path}.`);
      }
      let position: number;
      if (response.status === 206 && offset > 0) {
        position = offset;
      } else if (response.status === 200) {
        position = 0;
      } else if (response.status === 416) {
        // The server has nothing past our offset: the part is complete or
        // foreign. Let the hash decide; a mismatch restarts from zero.
        await response.body?.cancel().catch(() => undefined);
        return offset;
      } else {
        await response.body?.cancel().catch(() => undefined);
        throw new DownloadError('http', `The model server answered ${response.status} for ${file.path}.`);
      }
      if (!response.body) throw new DownloadError('network', `Empty response for ${file.path}.`);
      out = createWriteStream(part, { flags: position === 0 ? 'w' : 'a' });
      const reader = response.body.getReader();
      let finished = false;
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            if (local.signal.aborted) throw local.signal.reason;
            throw new DownloadError('network', `The connection dropped while downloading ${file.path}.`);
          }
          if (chunk.done) { finished = true; break; }
          arm();
          position += chunk.value.byteLength;
          if (position > file.sizeBytes) throw new DownloadError('integrity', `The server sent more bytes than expected for ${file.path}.`);
          await writeChunk(out, chunk.value);
          onBytes(position);
        }
      } finally {
        // Stop the transfer on any early exit, or the socket keeps filling memory.
        if (!finished) await reader.cancel().catch(() => undefined);
      }
      return position;
    } finally {
      clearTimeout(stallTimer);
      signal.removeEventListener('abort', forward);
      if (out) await closeStream(out).catch(() => undefined);
    }
  }
}
