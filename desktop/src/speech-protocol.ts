import { z } from 'zod';
import { FAMILIES, MODEL_FAMILIES, needsLanguage, SPEECH_LANGUAGES } from './speech-catalog/families.js';
import { modelPathProblem } from './speech-catalog/schema.js';
import { HALLUCINATION_PROFILES } from './speech-hallucinations.js';
import { INTERIM_MODES } from './speech-segmenter.js';

/**
 * Messages between the main process and the dictation utility process
 * (`speech-worker.mts`), and the events the renderer receives.
 *
 * Both directions are parsed: the worker trusts nothing it did not validate
 * before it reaches the native addon, and the main process trusts nothing a
 * crashed or replaced worker could send.
 */

export const DICTATION_SAMPLE_RATE = 16_000;
/** Upper bound of one fed chunk: 2 s of audio. The renderer sends ~100 ms. */
export const MAX_FEED_SAMPLES = DICTATION_SAMPLE_RATE * 2;

const sessionId = z.string().uuid();
const samples = z.custom<Float32Array>(
  (value) => value instanceof Float32Array && value.length > 0 && value.length <= MAX_FEED_SAMPLES,
  'expected a Float32Array of 1 to 2 s of audio',
);
/**
 * The file roles the worker hands to the addon. `data` files are not among
 * them: a graph finds its external data by the name written inside it.
 */
export const WORKER_FILE_ROLES = ['encoder', 'decoder', 'joiner', 'tokens'] as const;
export type WorkerFileRole = typeof WORKER_FILE_ROLES[number];

const relativePath = z.string().superRefine((path, ctx) => {
  const problem = modelPathProblem(path);
  if (problem) ctx.addIssue({ code: 'custom', message: `invalid file path: ${problem}` });
});

/**
 * What the worker loads. The family decides every addon key (`speech-sherpa.ts`);
 * the data only fills them: paths relative to the model folder, a language
 * from a closed list, options the family allows.
 */
export const workerInitSchema = z.strictObject({
  type: z.literal('init'),
  addonDir: z.string().min(1),
  modelDir: z.string().min(1),
  family: z.enum(MODEL_FAMILIES),
  files: z.partialRecord(z.enum(WORKER_FILE_ROLES), relativePath),
  /** Imposed at load; null lets the model detect it. */
  language: z.enum(SPEECH_LANGUAGES).nullable(),
  options: z.record(z.string(), z.union([z.boolean(), z.number().finite()])),
  filter: z.enum(HALLUCINATION_PROFILES),
  sampleRate: z.literal(DICTATION_SAMPLE_RATE),
  numThreads: z.number().int().min(1).max(8),
}).superRefine((init, ctx) => {
  const family = FAMILIES[init.family];
  const issue = (message: string, path: string[]): void => { ctx.addIssue({ code: 'custom', message, path }); };
  const allowed = new Set<string>([...family.requiredRoles, ...family.optionalRoles]);
  for (const role of family.requiredRoles) {
    if (role !== 'data' && !init.files[role]) issue(`the ${init.family} family needs a "${role}" file`, ['files', role]);
  }
  for (const role of Object.keys(init.files)) {
    if (!allowed.has(role)) issue(`role "${role}" is not used by the ${init.family} family`, ['files', role]);
  }
  if (init.language === null) {
    if (needsLanguage(init.family)) issue(`the ${init.family} family needs a language`, ['language']);
  } else if (!family.languages.includes(init.language)) {
    issue(`the ${init.family} family cannot impose "${init.language}"`, ['language']);
  }
  for (const [name, value] of Object.entries(init.options)) {
    const type = family.options[name];
    if (!type) issue(`option "${name}" is not allowed for the ${init.family} family`, ['options', name]);
    else if (typeof value !== type) issue(`option "${name}" must be a ${type}`, ['options', name]);
  }
});

/** When the session shows provisional text; the worker still floors it for a detected language. */
export const interimSchema = z.strictObject({
  mode: z.enum(INTERIM_MODES),
  minUtteranceMs: z.number().int().min(0).max(10_000),
});

export const workerInputSchema = z.discriminatedUnion('type', [
  workerInitSchema,
  z.object({ type: z.literal('start'), sessionId, interim: interimSchema.optional() }),
  z.object({ type: z.literal('feed'), sessionId, samples }),
  z.object({ type: z.literal('stop'), sessionId }),
  z.object({ type: z.literal('cancel'), sessionId }),
]);

export type WorkerInit = z.infer<typeof workerInitSchema>;
export type SpeechLanguage = WorkerInit['language'] & string;
export type WorkerInput = z.infer<typeof workerInputSchema>;

export const ERROR_CODES = ['engine-unavailable', 'model-missing', 'init-failed', 'engine-crashed', 'decode-failed', 'busy'] as const;
export type DictationErrorCode = typeof ERROR_CODES[number];

const text = z.string().max(20_000);

export const workerOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('init-failed'), message: z.string().max(2000) }),
  z.object({ type: z.literal('partial'), sessionId, text }),
  z.object({ type: z.literal('final'), sessionId, text }),
  z.object({ type: z.literal('error'), sessionId, code: z.enum(ERROR_CODES), message: z.string().max(2000) }),
  z.object({ type: z.literal('stopped'), sessionId }),
]);

export type WorkerOutput = z.infer<typeof workerOutputSchema>;

/**
 * What the renderer receives for a dictation session. `partial` is the text
 * of the utterance being spoken, replaced by the next partial; `final` is a
 * finished utterance to append; `stopped` is always the last event of a
 * session, after its last `final`.
 */
export type DictationEvent =
  | { type: 'partial'; sessionId: string; text: string }
  | { type: 'final'; sessionId: string; text: string }
  | { type: 'error'; sessionId: string; code: DictationErrorCode; message: string }
  | { type: 'stopped'; sessionId: string };
