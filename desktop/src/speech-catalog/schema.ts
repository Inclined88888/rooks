import { z } from 'zod';
import { HALLUCINATION_PROFILES } from '../speech-hallucinations.js';
import { FAMILIES, FILE_ROLES, isKnownFamily, LANGUAGE_MODES, MODEL_FAMILIES, REPEATABLE_ROLES } from './families.js';

/**
 * One speech model of the catalog (TODO #484): what to download, from where,
 * which bytes to expect, and what the product may promise about it.
 *
 * The same schema guards every origin: the built-in entries (parsed when the
 * module loads), a plugin's pack and a local import. A file is named by a
 * path relative to the model folder, never absolute, at most one level deep
 * (a tokenizer folder), and every file is pinned to its size and sha256: the
 * revision makes the URL stable, the hash makes the bytes trustworthy.
 */

export const MAX_MODEL_FILES = 16;
/** Per model, every file together. Cohere's int8 export is 2.9 GB. */
export const MAX_MODEL_BYTES = 8 * 1024 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['.onnx', '.data', '.txt', '.json', '.model'] as const;
/**
 * The word the Voice pane puts on a model (`precise`: the best accuracy, at
 * the price of size and memory). A closed list of product words, each
 * translated by the app: an entry picks one, it never brings its own text.
 */
export const SPEECH_MODEL_TIERS = ['precise'] as const;

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
/** Names Windows reserves for devices, whatever the extension (`nul.txt` too). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Why `path` cannot name a model file, or null when it can. */
export function modelPathProblem(path: string): string | null {
  if (path.length === 0 || path.length > 201) return 'empty or too long';
  const segments = path.split('/');
  if (segments.length > 2) return 'more than one folder level';
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return 'a "." or ".." segment';
    // Also catches a leading "/" (empty first segment), "\" and ":" (drive letters).
    if (!SEGMENT.test(segment)) return 'not a plain relative name';
    // Windows drops a trailing dot: "a." and "a" would be the same file there.
    if (segment.endsWith('.') || WINDOWS_DEVICE.test(segment)) return 'a name Windows cannot hold';
  }
  const name = segments.at(-1) ?? '';
  if (!ALLOWED_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) return 'an extension outside the allowed list';
  return null;
}

const modelPath = z.string().superRefine((path, ctx) => {
  const problem = modelPathProblem(path);
  if (problem) ctx.addIssue({ code: 'custom', message: `invalid file path: ${problem}` });
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256');
const byteCount = z.number().int().nonnegative().max(MAX_MODEL_BYTES);
const languageCode = z.string().regex(/^[a-z]{2,3}$/, 'expected an ISO 639 language code');
const httpsUrl = z.string().max(500).refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'expected an https URL');

export const modelFileSchema = z.strictObject({
  role: z.enum(FILE_ROLES),
  path: modelPath,
  sizeBytes: byteCount.positive(),
  sha256,
});

const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('huggingface'),
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/, 'expected owner/name'),
    revision: z.string().regex(/^[0-9a-f]{40}$/, 'expected a full commit sha'),
  }),
  // A local import: copied into the models folder, hashed there, never re-fetched.
  z.strictObject({ kind: z.literal('local') }),
]);

export const speechModelSchema = z.strictObject({
  schema: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, 'expected a lowercase id'),
  label: z.string().min(1).max(120),
  tier: z.enum(SPEECH_MODEL_TIERS).optional(),
  family: z.enum(MODEL_FAMILIES),
  source: sourceSchema,
  files: z.array(modelFileSchema).min(1).max(MAX_MODEL_FILES),
  memory: z.strictObject({ ramBytes: byteCount, peakRamBytes: byteCount }),
  languages: z.strictObject({
    codes: z.array(languageCode).min(1).max(200),
    mode: z.enum(LANGUAGE_MODES),
  }),
  interim: z.strictObject({
    mode: z.enum(['live', 'delayed', 'final-only']),
    /** No partial text before an utterance is this long. */
    minUtteranceMs: z.number().int().min(0).max(10_000).optional(),
  }),
  /** The anti-hallucination profile; each one is code, chosen by name. */
  filter: z.enum(HALLUCINATION_PROFILES),
  options: z.record(z.string(), z.union([z.boolean(), z.number().finite()])).default({}),
  license: z.strictObject({
    spdx: z.string().regex(/^[A-Za-z0-9.+-]{1,64}$/),
    attribution: z.string().min(1).max(300),
    /** Required for a download; a local import has no page to point to. */
    url: httpsUrl.optional(),
    /** `unknown` blocks a download from the catalog; a local import redistributes nothing. */
    redistribution: z.enum(['ok', 'unknown']),
  }),
  requires: z.strictObject({ addon: z.string().regex(/^>=\d+\.\d+\.\d+$/) }).optional(),
}).superRefine((model, ctx) => {
  const family = FAMILIES[model.family];
  const issue = (message: string, path: (string | number)[]): void => { ctx.addIssue({ code: 'custom', message, path }); };

  const isLocal = model.source.kind === 'local';
  if (isLocal !== model.id.startsWith('custom-')) {
    issue('the "custom-" prefix is reserved to, and required for, local imports', ['id']);
  }
  if (!isLocal && !model.license.url) issue('a downloaded model links to its licence', ['license', 'url']);

  const allowed = new Set([...family.requiredRoles, ...family.optionalRoles]);
  const counts = new Map<string, number>();
  const paths = new Set<string>();
  let total = 0;
  model.files.forEach((file, index) => {
    if (!allowed.has(file.role)) issue(`role "${file.role}" is not used by the ${model.family} family`, ['files', index, 'role']);
    counts.set(file.role, (counts.get(file.role) ?? 0) + 1);
    // Windows and macOS folders ignore case: two names differing by case are one file.
    const key = file.path.toLowerCase();
    if (paths.has(key)) issue('two files share this path', ['files', index, 'path']);
    paths.add(key);
    total += file.sizeBytes;
  });
  for (const role of family.requiredRoles) {
    if (!counts.has(role)) issue(`the ${model.family} family needs a "${role}" file`, ['files']);
  }
  for (const [role, count] of counts) {
    if (count > 1 && !REPEATABLE_ROLES.includes(role as typeof REPEATABLE_ROLES[number])) issue(`more than one "${role}" file`, ['files']);
  }
  if (total > MAX_MODEL_BYTES) issue('the model is larger than the 8 GB limit', ['files']);

  if (!family.languageModes.includes(model.languages.mode)) {
    issue(`the ${model.family} family cannot run in "${model.languages.mode}" language mode`, ['languages', 'mode']);
  }
  if (new Set(model.languages.codes).size !== model.languages.codes.length) issue('a language is listed twice', ['languages', 'codes']);
  // An imposed language reaches an addon parameter: only codes the family's code knows.
  if (model.languages.mode !== 'auto') {
    for (const code of model.languages.codes) {
      if (!family.languages.includes(code)) issue(`the ${model.family} family cannot impose "${code}"`, ['languages', 'codes']);
    }
  }

  for (const [name, value] of Object.entries(model.options)) {
    const type = family.options[name];
    if (!type) issue(`option "${name}" is not allowed for the ${model.family} family`, ['options', name]);
    else if (typeof value !== type) issue(`option "${name}" must be a ${type}`, ['options', name]);
  }

  if (model.memory.peakRamBytes < model.memory.ramBytes) issue('the peak is below the steady memory', ['memory', 'peakRamBytes']);
});

export type SpeechModel = z.infer<typeof speechModelSchema>;
export type SpeechModelFile = SpeechModel['files'][number];
export type SpeechModelInput = z.input<typeof speechModelSchema>;

export const speechCatalogSchema = z.array(speechModelSchema).superRefine((models, ctx) => {
  const ids = new Set<string>();
  models.forEach((model, index) => {
    if (ids.has(model.id)) ctx.addIssue({ code: 'custom', message: `duplicate model id "${model.id}"`, path: [index, 'id'] });
    ids.add(model.id);
  });
});

export type ParsedModel =
  | { ok: true; model: SpeechModel }
  /** `unknown-family`: the entry needs a newer Timon; show it, never run it. */
  | { ok: false; reason: 'unknown-family' | 'invalid'; issues: string[] };

export function parseSpeechModel(input: unknown): ParsedModel {
  const parsed = speechModelSchema.safeParse(input);
  if (parsed.success) return { ok: true, model: parsed.data };
  const family = input && typeof input === 'object' ? (input as { family?: unknown }).family : undefined;
  return {
    ok: false,
    reason: typeof family === 'string' && !isKnownFamily(family) ? 'unknown-family' : 'invalid',
    issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(entry)'}: ${issue.message}`),
  };
}

export function modelSize(model: SpeechModel): number {
  return model.files.reduce((total, file) => total + file.sizeBytes, 0);
}

/** The path's segments, for `join(dir, ...segments)`: never a "/" handed to the OS. */
export function pathSegments(file: SpeechModelFile): string[] {
  return file.path.split('/');
}

/** Public, unauthenticated download URL: nothing secret ever goes in it. Null for a local import. */
export function modelFileUrl(model: SpeechModel, file: SpeechModelFile): string | null {
  if (model.source.kind !== 'huggingface') return null;
  const path = pathSegments(file).map(encodeURIComponent).join('/');
  // portability: URL, not a filesystem path
  return `https://huggingface.co/${model.source.repository}/resolve/${model.source.revision}/${path}`;
}
