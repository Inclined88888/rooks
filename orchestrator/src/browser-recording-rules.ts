/**
 * The daemon's second masking pass over a browser recording (TODO #461).
 *
 * The desktop masks first (`desktop/src/native-browser-recorder.ts`); everything it sends is
 * still treated as untrusted here and masked again before it is sealed. The two packages are
 * built apart, so the rules below are a copy of the desktop's, kept honest by
 * `browser-recording-rules.test.ts`, which imports the desktop module and compares both.
 * Copied verbatim between the two markers: change them together.
 */

import { z } from 'zod';
import type {
  SecretKind, SecretHint, RecordedStep, RecordedStepType as ContractStepType,
  RecordingStopReason as ContractStopReason,
} from './plugins/contract/browser-recordings.js';
import type { Assert, Equals } from './type-equality.js';
export type { SecretKind, SecretHint, RecordedStep } from './plugins/contract/browser-recordings.js';

// --- copied from desktop/src/native-browser-recorder.ts -------------------------------------
export const SECRET_INPUT_TYPES: readonly string[] = ['password'];
export const SECRET_AUTOCOMPLETE_TOKENS: readonly string[] = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'];
// `autocomplete` is a space-separated token list: "username current-password" names a secret too.
// The preload and the daemon copy this exact source; their parity tests compare it.
export const SECRET_AUTOCOMPLETE_PATTERN = `(?:^|\\s)(?:${SECRET_AUTOCOMPLETE_TOKENS.join('|')})(?:\\s|$)`;
const SECRET_AUTOCOMPLETE = new RegExp(SECRET_AUTOCOMPLETE_PATTERN, 'i');
const SECRET_PLACEHOLDER = /^\{SECRET:[^{}]*\}$/;

export function isSecretPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && SECRET_PLACEHOLDER.test(value);
}

export function isSecretField(inputType = '', autocomplete = ''): boolean {
  return SECRET_INPUT_TYPES.includes(inputType.trim().toLowerCase()) || SECRET_AUTOCOMPLETE.test(autocomplete);
}

export function secretKindOf(inputType = '', autocomplete = ''): SecretKind {
  const tokens = autocomplete.toLowerCase().split(/\s+/);
  if (tokens.includes('one-time-code')) return 'otp';
  if (tokens.includes('cc-number') || tokens.includes('cc-csc')) return 'card';
  return 'password';
}

/** The placeholder label is a page string: keep it short and unable to close the placeholder. */
function placeholderLabel(name: string, inputType: string): string {
  const label = (name.replace(/[{}\s]+/g, ' ').trim() || inputType.trim().toLowerCase() || 'secret').slice(0, 64);
  return label.trim() || 'secret';
}

export function maskValue(value: unknown, inputType = '', autocomplete = '', name = ''): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (isSecretPlaceholder(text) || !isSecretField(inputType, autocomplete)) return text;
  return `{SECRET:${placeholderLabel(name, inputType)}}`;
}

// ---------------------------------------------------------------------------------------------
// Heuristic detector: a secret typed or pasted into an ordinary field (an API key into a search
// box, a card number into a notes field). It only flags; the review decides.

const API_KEY = /(?:^|[^A-Za-z0-9])(?:sk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|[sr]k_live_[0-9A-Za-z]{16,})/;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
const CARD_CANDIDATE = /\d(?:[ -]?\d){12,18}/g;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  const length = [...value].length;
  let entropy = 0;
  for (const count of counts.values()) { const p = count / length; entropy -= p * Math.log2(p); }
  return entropy;
}

function looksRandom(token: string): boolean {
  if (token.length < 20 || token.length > 512 || UUID.test(token) || EMAIL.test(token)) return false;
  if (/^[0-9a-f]{32,}$/i.test(token)) return shannonEntropy(token) >= 3;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(token)).length;
  return classes >= 3 && shannonEntropy(token) >= 3.5;
}

export function detectSecret(value: unknown): SecretHint | null {
  if (typeof value !== 'string' || !value || isSecretPlaceholder(value)) return null;
  const text = value.slice(0, 4096);
  if (API_KEY.test(text)) return 'api-key';
  if (JWT.test(text)) return 'jwt';
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'card-number';
  }
  for (const token of text.split(/\s+/)) {
    if (/^https?:\/\//i.test(token)) { if (maskedUrl(token).masked) return 'high-entropy'; continue; }
    if (looksRandom(token)) return 'high-entropy';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// URLs

const SENSITIVE_PARAMS = new Set(['code', 'token', 'access_token', 'id_token', 'refresh_token', 'auth', 'authorization',
  'key', 'apikey', 'api_key', 'secret', 'client_secret', 'password', 'passwd', 'pwd', 'pass', 'otp', 'sig', 'signature',
  'session', 'sessionid', 'session_id', 'sid', 'ticket', 'samlresponse', 'samlrequest', 'assertion', 'jwt',
  'code_verifier', 'oauth_token', 'oauth_verifier', 'magic', 'login_token', 'reset_token']);
const SENSITIVE_PARAM_PATTERN = /(?:^|[_.-])(?:token|secret|password|passwd|signature|credential)(?:$|[_.-])|(?:api|private|secret|access)[_-]?key/;

export function isSensitiveUrlParam(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return SENSITIVE_PARAMS.has(lower) || SENSITIVE_PARAM_PATTERN.test(lower);
}

export function isRecordableUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function decoded(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
}

const urlLabel = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'value';

function maskedUrl(raw: string): { url: string; masked: boolean } {
  let url: URL;
  try { url = new URL(raw); } catch { return { url: '', masked: false }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { url: '', masked: false };
  let masked = !!(url.username || url.password);
  const path = url.pathname.split('/').map((segment) => {
    if (!detectSecret(decoded(segment))) return segment;
    masked = true;
    return '{SECRET:path}';
  }).join('/');
  const query = url.search.slice(1);
  const pairs = query ? query.split('&').map((pair) => {
    const split = pair.indexOf('=');
    if (split < 0) return pair;
    const name = decoded(pair.slice(0, split));
    const value = pair.slice(split + 1);
    if (!value || (!isSensitiveUrlParam(name) && !detectSecret(decoded(value)))) return pair;
    masked = true;
    return `${pair.slice(0, split)}={SECRET:${urlLabel(name)}}`;
  }) : [];
  const fragment = url.hash.slice(1);
  // An implicit OAuth flow returns `#access_token=…`: any fragment carrying parameters is masked whole.
  const hidden = !!fragment && (fragment.includes('=') || !!detectSecret(decoded(fragment)));
  if (hidden) masked = true;
  return {
    url: `${url.protocol}//${url.host}${path}${pairs.length ? `?${pairs.join('&')}` : ''}${fragment ? (hidden ? '#{SECRET:fragment}' : `#${fragment}`) : ''}`,
    masked,
  };
}

/** Recordable form of a URL: credentials dropped, token-bearing parts replaced; '' when not HTTP(S). */
export function maskUrl(raw: string): string {
  return maskedUrl(raw).url;
}
// --- end of copy ------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Daemon side: what a recording becomes before it is sealed.

export const RECORDING_STEP_TYPES = ['click', 'input', 'secret', 'enter', 'navigate',
  'newTab', 'switchTab', 'closeTab', 'credential'] as const;
export type RecordedStepType = (typeof RECORDING_STEP_TYPES)[number];
/** The public contract spells both lists out; compilation fails if they part. */
type _RecordingStepTypesMatchContract = Assert<Equals<RecordedStepType, ContractStepType>>;
/** The stored ceiling (the desktop buffers up to 2 000 steps, the store keeps 1 000). */
export const RECORDING_STORE_MAX_STEPS = 1_000;
export const RECORDING_STORE_MAX_BYTES = 1_000_000;
export const RECORDING_STOP_REASONS = ['user', 'idle', 'limit', 'profile-stopped'] as const;
export type RecordingStopReason = (typeof RECORDING_STOP_REASONS)[number];
type _RecordingStopReasonsMatchContract = Assert<Equals<RecordingStopReason, ContractStopReason>>;

export interface SanitizedRecording {
  startedAt: number;
  url: string;
  steps: RecordedStep[];
  truncated: boolean;
  stoppedReason: RecordingStopReason;
}

const text = (max: number) => z.string().max(max).optional();
const RawStep = z.object({
  t: z.number().finite().nonnegative(),
  type: z.enum(RECORDING_STEP_TYPES),
  tabId: z.string().min(1).max(128),
  selector: text(500), tag: text(32), inputType: text(32), role: text(32), name: text(120), text: text(120),
  value: text(500), secret: z.enum(['password', 'otp', 'card']).optional(),
  flagged: z.enum(['api-key', 'jwt', 'card-number', 'high-entropy']).optional(),
  url: text(16_384), openerTabId: text(128), origin: text(2_048), credentialId: text(128),
});
const RawRecording = z.object({
  version: z.literal(1),
  startedAt: z.string().max(64),
  url: z.string().max(16_384),
  // The desktop's own ceiling; anything longer was not built by it.
  steps: z.array(z.unknown()).max(2_000),
  truncated: z.boolean(),
  stoppedReason: z.enum(RECORDING_STOP_REASONS),
});

const CREDENTIAL_REF = /^[A-Za-z0-9_-]{1,128}$/;
// A desktop placeholder is `{SECRET:<label of at most 64 characters>}`.
const MAX_PLACEHOLDER = 80;

/** One step as stored, or null to drop it. Never trusts what the desktop masked. */
function sanitizeStep(raw: unknown): Omit<RecordedStep, 'n'> | null {
  const parsed = RawStep.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const step: Omit<RecordedStep, 'n'> = { t: s.t, type: s.type, tabId: s.tabId };
  for (const key of ['selector', 'tag', 'inputType', 'role', 'text', 'openerTabId'] as const) {
    if (s[key]) step[key] = s[key];
  }
  if (s.name && !isSecretPlaceholder(s.name)) step.name = s.name;
  if (s.type === 'navigate') {
    const url = s.url ? maskUrl(s.url) : '';
    if (!url) return null;
    step.url = url;
    return step;
  }
  if (s.type === 'credential') {
    if (!isRecordableUrl(s.origin)) return null;
    step.origin = new URL(s.origin).origin;
    if (s.credentialId && CREDENTIAL_REF.test(s.credentialId)) step.credentialId = s.credentialId;
    return step;
  }
  if (s.type === 'secret' || s.secret || (s.type === 'input' && isSecretField(s.inputType ?? ''))) {
    step.type = 'secret';
    step.secret = s.secret ?? secretKindOf(s.inputType ?? '');
    step.value = s.value && isSecretPlaceholder(s.value) && s.value.length <= MAX_PLACEHOLDER
      ? s.value : `{SECRET:${placeholderLabel(s.name ?? '', s.inputType ?? '')}}`;
    return step;
  }
  if (s.type === 'input' && s.value !== undefined) step.value = s.value;
  const hint = s.flagged ?? detectSecret(step.value) ?? detectSecret(step.text);
  if (hint) step.flagged = hint;
  return step;
}

/** The recording the desktop returned, masked again, numbered and bounded; null when malformed. */
export function sanitizeRecording(raw: unknown, now: () => number = Date.now): SanitizedRecording | null {
  const parsed = RawRecording.safeParse(raw);
  if (!parsed.success) return null;
  const startedAt = Date.parse(parsed.data.startedAt);
  const steps: RecordedStep[] = [];
  let truncated = parsed.data.truncated;
  for (const candidate of parsed.data.steps) {
    const step = sanitizeStep(candidate);
    if (!step) continue;
    if (steps.length >= RECORDING_STORE_MAX_STEPS) { truncated = true; break; }
    steps.push({ n: steps.length + 1, ...step });
  }
  while (steps.length && JSON.stringify(steps).length > RECORDING_STORE_MAX_BYTES) { steps.pop(); truncated = true; }
  return {
    startedAt: Number.isFinite(startedAt) ? startedAt : now(),
    url: maskUrl(parsed.data.url),
    steps, truncated, stoppedReason: parsed.data.stoppedReason,
  };
}
