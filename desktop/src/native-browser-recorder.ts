/**
 * Recording of the built-in browser (TODO #461): the pure rules, without Electron, so that the
 * daemon can import them in its parity test and keep its own copy of the secret rule honest.
 *
 * Secrets are masked twice. The tab preload never reads the value of a secret field and ships a
 * `{SECRET:<field>}` placeholder; `normalizePageEvent` masks again from the type and autocomplete
 * the preload reports, so a page that swaps a field's type mid-flight still cannot hand over a
 * password. URLs are masked here too: OAuth callbacks and magic links carry tokens in the query,
 * the path or the fragment, and no page-side masking can see them.
 */

export const RECORDING_VERSION = 1;
export const RECORDING_MAX_STEPS = 2_000;
export const RECORDING_IDLE_MS = 30 * 60_000;
/** A page event is a few hundred bytes; anything far bigger is not from our preload. */
export const RECORDING_EVENT_MAX_BYTES = 8 * 1024;
/** Human input stays well below this; a page hammering the channel gets dropped, not buffered. */
export const RECORDING_MAX_PAGE_EVENTS_PER_SECOND = 20;

/** Commands only the user may send, marked `commandActor: 'human'` by the daemon. */
export const RECORDING_CONTROL_COMMANDS: ReadonlySet<string> = new Set(['recordStart', 'recordStop']);
/**
 * What an unmarked (agent) command may still do while a profile records: read, nothing that moves
 * the page. `revokePresentation` is the daemon's own lease bookkeeping, `presentation` the panel's.
 */
export const RECORDING_AGENT_ALLOWED_COMMANDS: ReadonlySet<string> = new Set(['status', 'start', 'recordStatus', 'screenshot',
  'consoleList', 'consoleGet', 'networkList', 'networkGet', 'downloadRead', 'chromeSigninStatus', 'presentation', 'revokePresentation']);

export const SECRET_INPUT_TYPES: readonly string[] = ['password'];
export const SECRET_AUTOCOMPLETE_TOKENS: readonly string[] = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'];
// `autocomplete` is a space-separated token list: "username current-password" names a secret too.
// The preload and the daemon copy this exact source; their parity tests compare it.
export const SECRET_AUTOCOMPLETE_PATTERN = `(?:^|\\s)(?:${SECRET_AUTOCOMPLETE_TOKENS.join('|')})(?:\\s|$)`;
const SECRET_AUTOCOMPLETE = new RegExp(SECRET_AUTOCOMPLETE_PATTERN, 'i');
const SECRET_PLACEHOLDER = /^\{SECRET:[^{}]*\}$/;

export type RecordingStepType = 'click' | 'input' | 'secret' | 'enter' | 'navigate'
  | 'newTab' | 'switchTab' | 'closeTab' | 'credential';
export type SecretKind = 'password' | 'otp' | 'card';
export type SecretHint = 'api-key' | 'jwt' | 'card-number' | 'high-entropy';
export type RecordingStopReason = 'user' | 'idle' | 'limit' | 'profile-stopped';

export interface RecordingStep {
  /** Epoch milliseconds while buffered; seconds since the first step once built. */
  t: number;
  type: RecordingStepType;
  tabId: string;
  selector?: string;
  tag?: string;
  inputType?: string;
  role?: string;
  /** Accessible name of the element (label, aria-label, placeholder): a page string, never a field value. */
  name?: string;
  text?: string;
  value?: string;
  secret?: SecretKind;
  /** The heuristic detector thinks this value may be a secret: the review masks it by default. */
  flagged?: SecretHint;
  url?: string;
  openerTabId?: string;
  origin?: string;
  credentialId?: string;
}

export interface RecordingResult {
  version: typeof RECORDING_VERSION;
  startedAt: string;
  url: string;
  steps: RecordingStep[];
  truncated: boolean;
  stoppedReason: RecordingStopReason;
}

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

// ---------------------------------------------------------------------------------------------
// Page events (what the preload sends) to steps.

const PAGE_EVENT_TYPES = new Set(['click', 'input', 'enter']);
const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function stringOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function tokenOf(value: unknown): string {
  const text = stringOf(value, 32).toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(text) ? text : '';
}

/** Selector with fallbacks: the recorded one, then tag (+ a kept label), then `*`; never ''. */
export function selectorFor(event: { selector?: unknown; tag?: unknown; text?: unknown }): string {
  const selector = stringOf(event.selector, 500);
  if (selector) return selector;
  const tag = tokenOf(event.tag);
  const text = stringOf(event.text, 40);
  if (tag && text) return `${tag}:contains(${JSON.stringify(text)})`;
  return tag || '*';
}

/** A click on a form field, whose "text" could only be what was typed into it. */
function isFieldClick(tag: string, inputType: string, autocomplete: string): boolean {
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input' && !BUTTON_INPUT_TYPES.has(inputType)) return true;
  return isSecretField(inputType, autocomplete);
}

export function acceptsPageEventSize(payload: unknown): boolean {
  try { return JSON.stringify(payload).length <= RECORDING_EVENT_MAX_BYTES; } catch { return false; }
}

/** One preload event as a buffered step, or null to drop it. `t` and `tabId` come from the main process. */
export function normalizePageEvent(raw: unknown, context: { t: number; tabId: string }): RecordingStep | null {
  if (!isPlainObject(raw) || !Number.isFinite(context.t) || context.t < 0) return null;
  const type = stringOf(raw.type, 16).toLowerCase();
  if (!PAGE_EVENT_TYPES.has(type)) return null;
  const tag = tokenOf(raw.tag);
  const inputType = tokenOf(raw.inputType);
  const autocomplete = stringOf(raw.autocomplete, 256);
  const role = tokenOf(raw.role);
  const name = stringOf(raw.name, 120);
  const step: RecordingStep = { t: context.t, type: type as RecordingStepType, tabId: context.tabId };
  if (type === 'click') {
    const text = isFieldClick(tag, inputType, autocomplete) ? '' : stringOf(raw.text, 120);
    step.selector = selectorFor({ selector: raw.selector, tag, text });
    if (text) step.text = text;
    const hint = detectSecret(text);
    if (hint) step.flagged = hint;
  } else {
    step.selector = selectorFor({ selector: raw.selector, tag });
  }
  if (tag) step.tag = tag;
  if (inputType) step.inputType = inputType;
  if (role) step.role = role;
  if (name && !isSecretPlaceholder(name)) step.name = name;
  if (type === 'input') {
    // The preload also sends a placeholder for a field that WAS a password before a "show" toggle.
    if (isSecretField(inputType, autocomplete) || isSecretPlaceholder(raw.value)) {
      step.type = 'secret';
      step.secret = secretKindOf(inputType, autocomplete);
      // Rebuilt from the field name: whatever arrived as a value is never kept, placeholder or not.
      step.value = `{SECRET:${placeholderLabel(stringOf(raw.field, 64), inputType)}}`;
    } else if (inputType !== 'file') {
      step.value = stringOf(raw.value, 500);
      const hint = detectSecret(step.value);
      if (hint) step.flagged = hint;
      if (tag === 'select') {
        const option = stringOf(raw.text, 120);
        if (option) step.text = option;
      }
    }
  }
  return step;
}

/** A top-frame navigation as a step, or null for internal pages (about:, devtools:, chrome-error:…). */
export function navigationStep(url: unknown, context: { t: number; tabId: string }): RecordingStep | null {
  if (!isRecordableUrl(url)) return null;
  const masked = maskUrl(url);
  return masked ? { t: context.t, type: 'navigate', tabId: context.tabId, url: masked } : null;
}

const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function credentialStep(origin: unknown, credentialId: unknown, context: { t: number; tabId: string }): RecordingStep | null {
  if (!isRecordableUrl(origin)) return null;
  const parsed = new URL(origin).origin;
  return { t: context.t, type: 'credential', tabId: context.tabId, origin: parsed,
    ...(typeof credentialId === 'string' && CREDENTIAL_ID.test(credentialId) ? { credentialId } : {}) };
}

/**
 * Order by capture time, then rebase `t` to seconds since the first step. Epoch-millisecond
 * stamps (what the engine buffers) become seconds; small already-relative values pass through.
 */
export function buildSteps(steps: readonly RecordingStep[]): RecordingStep[] {
  const ordered = steps.filter((step) => Number.isFinite(step.t)).map((step) => ({ ...step }))
    .sort((a, b) => a.t - b.t);
  // Chromium fires `change` after the Enter keydown that submits a form: put the value first.
  for (let index = 0; index + 1 < ordered.length; index++) {
    const [enter, input] = [ordered[index]!, ordered[index + 1]!];
    if (enter.type === 'enter' && (input.type === 'input' || input.type === 'secret') && enter.tabId === input.tabId
      && enter.selector === input.selector && input.t - enter.t <= (enter.t > 1e10 ? 1000 : 1)) {
      ordered[index] = input; ordered[index + 1] = enter;
      [input.t, enter.t] = [enter.t, input.t];
    }
  }
  if (ordered.length) {
    const base = ordered[0]!.t;
    for (const step of ordered) {
      const relative = step.t - base;
      step.t = Math.round((base > 1e10 ? relative / 1000 : relative) * 1000) / 1000;
    }
  }
  return ordered;
}

/**
 * One recording in memory. Nothing here touches the disk: the daemon collects the result and
 * seals it, and quitting the app drops it.
 */
export class RecordingSession {
  readonly startedAt: number;
  private readonly steps: RecordingStep[] = [];
  private readonly pageEvents: number[] = [];
  private lastActivity: number;
  active = true;
  truncated = false;
  stoppedReason: RecordingStopReason | null = null;

  constructor(readonly url: string, private readonly now: () => number = Date.now) {
    this.startedAt = this.lastActivity = now();
  }

  get count(): number { return this.steps.length; }

  /** False when the step was refused (inactive, rate, full). A full buffer stops the recording. */
  add(step: RecordingStep | null, options: { page?: boolean } = {}): boolean {
    if (!this.active || !step) return false;
    const now = this.now();
    if (options.page) {
      while (this.pageEvents.length && now - this.pageEvents[0]! >= 1000) this.pageEvents.shift();
      if (this.pageEvents.length >= RECORDING_MAX_PAGE_EVENTS_PER_SECOND) return false;
      this.pageEvents.push(now);
    }
    if (this.steps.length >= RECORDING_MAX_STEPS) {
      this.truncated = true;
      this.stop('limit');
      return false;
    }
    this.steps.push(step);
    this.lastActivity = now;
    if (this.steps.length >= RECORDING_MAX_STEPS) { this.truncated = true; this.stop('limit'); }
    return true;
  }

  /** Milliseconds left before the idle stop; 0 once idle. */
  idleRemaining(): number {
    return Math.max(0, this.lastActivity + RECORDING_IDLE_MS - this.now());
  }

  stop(reason: RecordingStopReason): void {
    if (!this.active) return;
    this.active = false;
    this.stoppedReason = reason;
  }

  result(): RecordingResult {
    return {
      version: RECORDING_VERSION, startedAt: new Date(this.startedAt).toISOString(), url: this.url,
      steps: buildSteps(this.steps), truncated: this.truncated, stoppedReason: this.stoppedReason ?? 'user',
    };
  }
}
