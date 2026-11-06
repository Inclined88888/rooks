import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { lstat, open, readdir, statfs } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { FAMILIES, MODEL_FAMILIES, type FileRole, type ModelFamily } from './speech-catalog/families.js';
import {
  MAX_MODEL_BYTES, MAX_MODEL_FILES, modelPathProblem, modelSize, speechModelSchema, type SpeechModel, type SpeechModelInput,
} from './speech-catalog/schema.js';
import type { EnginePort } from './speech-engine-host.js';
import type { ModelState, SpeechModelManager, VetResult } from './speech-model-manager.js';
import { inspectModelGraphs, inspectOnnx, OnnxRefused } from './speech-onnx-inspect.js';
import { workerOutputSchema, type WorkerInit } from './speech-protocol.js';
import { shellText, type ShellTranslator } from './shell-i18n.js';

/**
 * "Add a local model" (TODO #484, A3, vault note §2.4): a folder the user
 * picked in a native dialog the main process opened, turned into a model of
 * the catalog. The renderer never names a path.
 *
 * In order, before the addon sees anything:
 *   1. the folder is read one level deep: regular files only (no link, no
 *      FIFO or device), allowed extensions, at most 16 files and 8 GB;
 *   2. the family is the user's choice or deduced from the names, and every
 *      role it needs has exactly one file;
 *   3. each file is copied into the models folder, re-checked as the same
 *      regular file and hashed while it streams: the original may change
 *      afterwards, the copy is what runs;
 *   4. the copied graphs are inspected (`speech-onnx-inspect.ts`), and the
 *      external-data files they read are copied too, from the same listing;
 *   5. a disposable process loads the model once: an invalid model aborts
 *      that process (an `Ort::Exception` is not a JS error), not the engine;
 *   6. the marker is written with `verified: false`, the folder moved in place.
 */

export type ImportErrorCode =
  | 'cancelled' | 'busy' | 'engine-unavailable'
  | 'not-a-folder' | 'symlink' | 'special-file' | 'nested-folder' | 'extension' | 'file-name' | 'too-many-files' | 'too-large'
  | 'family-needed' | 'roles' | 'languages-needed' | 'unsupported-family'
  | 'unsafe-graph' | 'changed' | 'disk-full' | 'load-failed' | 'io';

export class ImportRefused extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly detail: { file?: string; candidates?: ModelFamily[] } = {},
  ) {
    super(message);
  }
}

const languageCode = z.string().regex(/^[a-z]{2,3}$/);

/** What the renderer may say about an import: a family and languages, never a path. */
export const importRequestSchema = z.strictObject({
  family: z.enum(MODEL_FAMILIES).optional(),
  languages: z.array(languageCode).min(1).max(200).optional(),
}).optional();
export type ImportRequest = NonNullable<z.infer<typeof importRequestSchema>>;

/**
 * Left in the folder, never copied: what a Hugging Face clone of a sherpa
 * export carries besides the model. A link is refused even under these names.
 */
const IGNORED_DIR = /^(\..*|test_wavs)$/i;
const IGNORED_FILE = /^(\..*|(readme|license|licence|notice|copying)(\..*)?|.*\.(md|wav|py|sh))$/i;

export type ScannedFile = { name: string; sizeBytes: number; dev: number; ino: number };

/** Step 1: the model files of `source`, refused on the first entry that does not belong there. */
export async function scanModelFolder(source: string): Promise<ScannedFile[]> {
  const info = await lstat(source).catch(() => null);
  if (!info) throw new ImportRefused('not-a-folder', 'The selected folder cannot be read.');
  if (info.isSymbolicLink()) throw new ImportRefused('symlink', 'The selected folder is a link: pick the folder it points to.');
  if (!info.isDirectory()) throw new ImportRefused('not-a-folder', 'The selection is not a folder.');
  let names: string[];
  try {
    names = await readdir(source);
  } catch {
    throw new ImportRefused('not-a-folder', 'The selected folder cannot be read.');
  }
  const files: ScannedFile[] = [];
  let total = 0;
  for (const name of names.sort()) {
    const entry = await lstat(join(source, name)).catch(() => null);
    if (!entry) throw new ImportRefused('io', `${display(name)} cannot be read.`, { file: display(name) });
    if (entry.isSymbolicLink()) throw new ImportRefused('symlink', `${display(name)} is a link: a model folder holds only real files.`, { file: display(name) });
    if (entry.isDirectory()) {
      if (IGNORED_DIR.test(name)) continue;
      throw new ImportRefused('nested-folder', `${display(name)} is a folder: a model folder holds its files directly.`, { file: display(name) });
    }
    if (!entry.isFile()) throw new ImportRefused('special-file', `${display(name)} is not a regular file.`, { file: display(name) });
    if (IGNORED_FILE.test(name)) continue;
    const problem = modelPathProblem(name);
    if (problem) {
      const code = problem.startsWith('an extension') ? 'extension' : 'file-name';
      throw new ImportRefused(code, `${display(name)} cannot be part of a model: ${problem}.`, { file: display(name) });
    }
    files.push({ name, sizeBytes: entry.size, dev: entry.dev, ino: entry.ino });
    total += entry.size;
    if (files.length > MAX_MODEL_FILES) {
      throw new ImportRefused('too-many-files', `A model holds at most ${MAX_MODEL_FILES} files.`);
    }
  }
  if (total > MAX_MODEL_BYTES) throw new ImportRefused('too-large', 'A model is at most 8 GB.');
  if (files.length === 0) throw new ImportRefused('roles', 'The folder holds no model file.');
  return files;
}

/** File names from disk reach messages shortened and without control or direction characters. */
function display(name: string): string {
  return sanitizeText(name, 80);
}

export function sanitizeText(text: string, max: number): string {
  // C0/C1 controls and the bidi overrides that could reorder a dialog line.
  return text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}

type NamedRole = Exclude<FileRole, 'data'>;

const ROLE_MATCH: Readonly<Record<NamedRole, (lower: string) => boolean>> = {
  encoder: (name) => name.includes('encoder') && name.endsWith('.onnx'),
  decoder: (name) => name.includes('decoder') && name.endsWith('.onnx'),
  joiner: (name) => name.includes('joiner') && name.endsWith('.onnx'),
  tokens: (name) => name.endsWith('tokens.txt'),
};

function candidatesFor(files: readonly ScannedFile[], role: NamedRole): ScannedFile[] {
  return files.filter((file) => ROLE_MATCH[role](file.name.toLowerCase()));
}

/** Families that look the same from their names: the user tells them apart. */
const UNJOINED_FAMILIES: ModelFamily[] = ['nemo-canary', 'whisper', 'cohere-transcribe'];

/** Step 2: the family, and the one file of each role it needs. */
export function assignRoles(files: readonly ScannedFile[], family?: ModelFamily): { family: ModelFamily; roles: Map<NamedRole, ScannedFile> } {
  let chosen = family;
  if (!chosen) {
    if (candidatesFor(files, 'joiner').length > 0) {
      chosen = 'nemo-transducer';
    } else if ((['encoder', 'decoder', 'tokens'] as const).every((role) => candidatesFor(files, role).length > 0)) {
      throw new ImportRefused('family-needed', 'Choose which kind of model this folder holds.', { candidates: UNJOINED_FAMILIES });
    } else {
      throw new ImportRefused('roles', 'The folder does not look like a speech model (encoder, decoder and tokens files).');
    }
  }
  const roles = new Map<NamedRole, ScannedFile>();
  for (const role of FAMILIES[chosen].requiredRoles) {
    if (role === 'data') continue;
    const found = candidatesFor(files, role);
    if (found.length === 0) throw new ImportRefused('roles', `No ${role} file for a ${chosen} model.`);
    if (found.length > 1) {
      throw new ImportRefused('roles', `Several files could be the ${role}: ${found.map((file) => display(file.name)).join(', ')}. Keep one.`);
    }
    roles.set(role, found[0] as ScannedFile);
  }
  return { family: chosen, roles };
}

/**
 * The languages of an import. Without a list, a family that detects the
 * language runs in Auto and claims none (`und`): the product never picks it
 * for a language by itself; one that cannot detect it needs the list.
 */
export function importLanguages(family: ModelFamily, languages: readonly string[] | undefined): SpeechModel['languages'] {
  const modes = FAMILIES[family].languageModes;
  if (languages && languages.length > 0) {
    const mode = modes.includes('forced') ? 'forced' : modes.includes('required') ? 'required' : 'auto';
    return { codes: [...new Set(languages)], mode };
  }
  if (modes.includes('auto')) return { codes: ['und'], mode: 'auto' };
  throw new ImportRefused('languages-needed', 'Choose the languages of this model.');
}

const FAMILY_DEFAULTS: Readonly<Record<ModelFamily, Pick<SpeechModel, 'interim' | 'filter'>>> = {
  // Same safeguard as Parakeet: under 2 s a detecting model may hear English (TODO #482).
  'nemo-transducer': { interim: { mode: 'live', minUtteranceMs: 2000 }, filter: 'nemo' },
  'nemo-canary': { interim: { mode: 'live' }, filter: 'nemo' },
  // 1 to 2 s per decode: no live partial is promised.
  whisper: { interim: { mode: 'final-only' }, filter: 'whisper-like' },
  'cohere-transcribe': { interim: { mode: 'final-only' }, filter: 'cohere' },
};

/** `custom-<slug>` from the folder name: lowercase ASCII, digits, `.` and `-`. */
export function importSlug(folderName: string): string {
  const slug = folderName.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+/, '').slice(0, 48).replace(/[-.]+$/, '');
  return slug || 'model';
}

const COPY_CHUNK = 1024 * 1024;
/** Room left on the disk after the copy, as for a download. */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;

/**
 * Step 3: one file, opened without following a link where the OS allows it,
 * checked as the very file the scan saw, streamed into `target` and hashed.
 */
export async function copyScannedFile(source: string, file: ScannedFile, target: string): Promise<string> {
  // O_NOFOLLOW does not exist on Windows; the lstat of the scan and the fstat below cover it there.
  const noFollow = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  const input = await open(join(source, file.name), fsConstants.O_RDONLY | noFollow).catch(() => {
    throw new ImportRefused('changed', `${display(file.name)} changed during the import.`, { file: display(file.name) });
  });
  try {
    const info = await input.stat();
    const sameFile = !file.ino || !info.ino || (info.ino === file.ino && info.dev === file.dev);
    if (!info.isFile() || info.size !== file.sizeBytes || !sameFile) {
      throw new ImportRefused('changed', `${display(file.name)} changed during the import.`, { file: display(file.name) });
    }
    const output = await open(target, 'wx');
    const hash = createHash('sha256');
    let copied = 0;
    try {
      const buffer = Buffer.alloc(COPY_CHUNK);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, COPY_CHUNK, copied);
        if (bytesRead === 0) break;
        copied += bytesRead;
        if (copied > file.sizeBytes) break;
        hash.update(buffer.subarray(0, bytesRead));
        await output.write(buffer, 0, bytesRead);
      }
    } finally {
      await output.close();
    }
    if (copied !== file.sizeBytes) {
      throw new ImportRefused('changed', `${display(file.name)} changed during the import.`, { file: display(file.name) });
    }
    return hash.digest('hex');
  } finally {
    await input.close();
  }
}

export type ImportDeps = {
  manager: Pick<SpeechModelManager, 'has' | 'stage' | 'discardStage' | 'commitImport'>;
  modelsDir: () => Promise<string>;
  /** Whether this desktop's engine can load the family at all. */
  runnable: (family: ModelFamily) => boolean;
  /** Step 5. */
  probe: (model: SpeechModel, dir: string) => Promise<VetResult>;
  freeBytes?: (dir: string) => Promise<number | null>;
};

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

/** Imports the folder `source`; throws `ImportRefused` with the reason it was not. */
export async function importModelFolder(source: string, request: ImportRequest, deps: ImportDeps): Promise<{ model: SpeechModel; state: ModelState }> {
  const scanned = await scanModelFolder(source);
  const { family, roles } = assignRoles(scanned, request.family);
  if (!deps.runnable(family)) {
    throw new ImportRefused('unsupported-family', 'This version of Timon cannot run this kind of model yet.');
  }
  const languages = importLanguages(family, request.languages);

  const modelsDir = await deps.modelsDir();
  const base = `custom-${importSlug(basename(source))}`;
  let id: string | null = null;
  for (let n = 1; n < 100 && !id; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await deps.manager.has(candidate)) && !existsSync(join(modelsDir, candidate))) id = candidate;
  }
  if (!id) throw new ImportRefused('io', 'Too many models imported from folders of this name.');

  const wanted = [...roles.values()].reduce((sum, file) => sum + file.sizeBytes, 0);
  const free = await (deps.freeBytes ?? defaultFreeBytes)(modelsDir);
  if (free !== null && free < wanted + DISK_MARGIN_BYTES) throw new ImportRefused('disk-full', 'Not enough free disk space for this model.');

  const staging = await deps.manager.stage(id);
  try {
    const files: SpeechModelInput['files'] = [];
    for (const [role, file] of roles) {
      files.push({ role, path: file.name, sizeBytes: file.sizeBytes, sha256: await copyScannedFile(source, file, join(staging, file.name)) });
    }
    // Step 4, on the copies: the graphs may only read files of this listing, next to them.
    const listed = new Map(scanned.map((file) => [file.name, file]));
    const external = new Set<string>();
    for (const file of files) {
      if (!file.path.toLowerCase().endsWith('.onnx')) continue;
      try {
        const result = await inspectOnnx(join(staging, file.path), { isModelFile: (name) => listed.has(name) });
        for (const name of result.externalFiles) external.add(name);
      } catch (error) {
        if (!(error instanceof OnnxRefused)) throw error;
        throw new ImportRefused('unsafe-graph', `${display(file.path)}: ${error.message}`, { file: display(file.path) });
      }
    }
    for (const name of [...external].sort()) {
      const file = listed.get(name);
      if (!file || files.some((copied) => copied.path === name)) continue;
      files.push({ role: 'data', path: name, sizeBytes: file.sizeBytes, sha256: await copyScannedFile(source, file, join(staging, name)) });
    }

    const parsed = speechModelSchema.safeParse({
      schema: 1,
      id,
      label: sanitizeText(basename(source), 120) || 'Imported model',
      family,
      source: { kind: 'local' },
      files,
      // Not measured for an import: 0 reads "unknown".
      memory: { ramBytes: 0, peakRamBytes: 0 },
      languages,
      ...FAMILY_DEFAULTS[family],
      license: { spdx: 'NOASSERTION', attribution: 'Imported from a local folder', redistribution: 'unknown' },
    } satisfies SpeechModelInput);
    if (!parsed.success) {
      throw new ImportRefused('roles', `These files do not make a valid ${family} model: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
    }
    const model = parsed.data;
    if (modelSize(model) > MAX_MODEL_BYTES) throw new ImportRefused('too-large', 'A model is at most 8 GB.');
    // The whole model once more, as the engine will see it.
    const inspected = await inspectModelGraphs(model, staging);
    if (!inspected.ok) throw new ImportRefused('unsafe-graph', inspected.message);

    const probed = await deps.probe(model, staging);
    if (!probed.ok) {
      throw new ImportRefused('load-failed', `This folder is not a valid ${family} model: ${probed.message}`);
    }
    const state = await deps.manager.commitImport(model);
    return { model, state };
  } catch (error) {
    await deps.manager.discardStage(id).catch(() => undefined);
    throw error;
  }
}

export type ProbeOutcome = VetResult;

/** Bounded by the size: loading 2.9 GB takes far longer than 200 MB. */
export function probeTimeoutMs(model: SpeechModel): number {
  return Math.min(300_000, 30_000 + Math.ceil(modelSize(model) / 1e9) * 20_000);
}

/**
 * Step 5: loads `init` in a process of its own and ends it. A model the
 * addon cannot load aborts that process; it is reported here, the live
 * engine never saw it.
 */
export function probeModel(spawn: (init: WorkerInit) => EnginePort, init: WorkerInit, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let port: EnginePort | null = null;
    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.kill(); } catch { /* already gone */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, message: 'Loading the model took too long.' }), timeoutMs);
    try {
      port = spawn(init);
    } catch {
      finish({ ok: false, message: 'The model check could not start.' });
      return;
    }
    port.on('message', (raw) => {
      const parsed = workerOutputSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.type === 'ready') finish({ ok: true });
      else if (parsed.data.type === 'init-failed') finish({ ok: false, message: 'The engine could not load the model.' });
    });
    port.on('exit', () => finish({ ok: false, message: 'The engine stopped while loading the model.' }));
    port.postMessage(init);
  });
}

/** The native folder picker of "Add a local model". */
export function importDialogOptions(locale: string): { title: string; buttonLabel: string; properties: ['openDirectory'] } {
  const t = shellText(locale);
  return { title: t('speech.importTitle'), buttonLabel: t('speech.importButton'), properties: ['openDirectory'] };
}

function megabytes(bytes: number, t: ShellTranslator): string {
  return t('speech.megabytes', { value: Math.max(1, Math.round(bytes / 1e6)) });
}

/**
 * The confirmation the main process owns before a plugin's pack downloads
 * (vault note §2.2): everything shown is computed here from the parsed entry.
 * Button 0 cancels; it is also the default and the answer to Escape. The
 * entry is the installed plugin's, read from the daemon (TODO #584), so the
 * box names the plugin it comes from; it never says that plugin is asking:
 * any page of the shared realm can name another plugin's entry.
 */
export function packConfirmDialog(model: SpeechModel, pluginId: string, locale: string): {
  type: 'question'; title: string; message: string; detail: string; buttons: string[]; defaultId: 0; cancelId: 0; noLink: true;
} {
  const t = shellText(locale);
  const source = model.source.kind === 'huggingface'
    // portability: URL, not a filesystem path
    ? `huggingface.co/${model.source.repository} (${model.source.revision.slice(0, 12)})`
    : '—';
  const size = megabytes(modelSize(model), t);
  const lines = [
    // Read from the installed package by the main process (TODO #584), not written by a page.
    t('speech.packPlugin', { plugin: pluginId }),
    t('speech.packSource', { source }),
    model.memory.ramBytes > 0 ? t('speech.packSizeMemory', { size, memory: megabytes(model.memory.ramBytes, t) }) : t('speech.packSize', { size }),
    t('speech.packLanguages', { languages: model.languages.codes.join(', ') }),
    t('speech.packLicence', { licence: `${sanitizeText(model.license.spdx, 64)} — ${sanitizeText(model.license.attribution, 200)}` }),
    '',
    t('speech.packWarning'),
  ];
  return {
    type: 'question',
    title: t('speech.packTitle'),
    message: t('speech.packMessage', { label: sanitizeText(model.label, 120) }),
    detail: lines.join('\n'),
    buttons: [t('speech.cancel'), t('speech.download')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
