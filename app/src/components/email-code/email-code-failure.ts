/**
 * What a refused code request means for the reader (docs/EMAIL-CODES.md,
 * docs/EMAIL-CODE-UI.md): the daemon's error, in the reader's language, and —
 * for the refusals that only ask to wait — the moment the wait ends, so the
 * sentence counts the seconds down like the 60 s of "Resend".
 *
 * Pure: no React, no fetch. The screens build a `CodeFailure` from an answer
 * and read it again at every tick with `failureText`.
 */
import { apiErrorKey, parseApiError } from '@/lib/api-error';
import { hasKey, t } from '@/lib/i18n';

/**
 * The refusals that end by themselves: the daemon says how long, in seconds —
 * `retryAfter` in the body, or only the `Retry-After` header for the login
 * throttle's `too_many_attempts` (`sendThrottled`).
 */
export const WAIT_CODES: ReadonlySet<string> = new Set([
  'email_code_too_soon',
  'email_code_origin_limited',
  'email_code_busy',
  'email_rate_limited',
  'too_many_attempts',
]);

/**
 * A wait whose shared message has no `{seconds}` (`too_many_attempts` is said
 * by every throttled route, most of which show no countdown): counted down
 * here with a sentence of its own.
 */
const WAIT_KEYS: Readonly<Record<string, string>> = { too_many_attempts: 'emailCode.tooManyAttemptsWait' };

function messageKey(code: string, counted: boolean): string {
  return (counted ? WAIT_KEYS[code] : undefined) ?? apiErrorKey(code);
}

/**
 * The `Retry-After` header, in seconds: a number of seconds or an HTTP date
 * (RFC 9110). `null` when absent or unreadable.
 */
export function retryAfterSeconds(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/** The digits of a code; the daemon's are six. */
export const CODE_LENGTH = 6;

export type CodeFailure = {
  /** The daemon's stable code, `network` when no answer came back at all. */
  code: string | null;
  /** HTTP status; `0` when the request never got an answer. */
  status: number;
  params: Readonly<Record<string, string | number>>;
  /** The sentence when nothing is counted down. */
  message: string;
  /** For a refusal that asks to wait: when the wait is over (ms, this browser's clock). */
  retryUntil: number | null;
  /** For a wrong code: the tries left on this code. */
  attemptsLeft: number | null;
};

/** Keeps the digits a reader typed or pasted, at most `CODE_LENGTH` of them. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads a refusal. `fallback` turns an error the dictionary does not know
 * (the setup's uncoded `setup_token_required`…) into words; without it, the
 * daemon's English, then the HTTP status.
 */
export function codeFailure(
  status: number,
  body: unknown,
  now: number,
  fallback?: (error: string | undefined) => string,
  headerSeconds: number | null = null,
): CodeFailure {
  const parsed = parseApiError(body);
  const raw = (body && typeof body === 'object' ? body : {}) as { retryAfter?: unknown; attemptsLeft?: unknown };
  const code = parsed?.code ?? null;
  const params = { ...(parsed?.params ?? {}) };
  const attemptsLeft = finiteNumber(raw.attemptsLeft) ?? finiteNumber(params.attemptsLeft);
  // The body says it when it can; the header is the fallback of a refusal that only carries it.
  const seconds = finiteNumber(raw.retryAfter) ?? finiteNumber(params.seconds) ?? headerSeconds;
  const retryUntil = code !== null && WAIT_CODES.has(code) && seconds !== null && seconds > 0 ? now + seconds * 1000 : null;
  if (retryUntil !== null) params.seconds = Math.ceil(seconds ?? 0);
  if (attemptsLeft !== null && params.attemptsLeft === undefined) params.attemptsLeft = attemptsLeft;
  let message: string;
  if (code !== null && hasKey(messageKey(code, retryUntil !== null))) message = t(messageKey(code, retryUntil !== null), params);
  else if (fallback) message = fallback(parsed?.message || undefined);
  else if (parsed?.message) message = parsed.message;
  else message = t('apiErrors.http_status', { status });
  return { code, status, params, message, retryUntil, attemptsLeft };
}

/** The request never got an answer: the app itself is out of reach. */
export function networkFailure(): CodeFailure {
  return { code: 'network', status: 0, params: {}, message: t('emailCode.unreachable'), retryUntil: null, attemptsLeft: null };
}

/** No challenge left to check a code against: the reader asks for a new one. */
export function expiredChallenge(): CodeFailure {
  return codeFailure(410, { code: 'email_code_expired' }, Date.now());
}

/** Whole seconds left before `until`, never below zero. */
export function secondsLeft(until: number | null, now: number): number {
  if (until === null) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * The sentence to show at `now`: a wait counts its seconds down and is gone
 * once over (`null`), every other refusal stays as it was said.
 */
export function failureText(failure: CodeFailure | null, now: number): string | null {
  if (!failure) return null;
  if (failure.retryUntil === null) return failure.message;
  const left = secondsLeft(failure.retryUntil, now);
  if (left === 0) return null;
  const key = failure.code ? messageKey(failure.code, true) : '';
  return key && hasKey(key) ? t(key, { ...failure.params, seconds: left }) : failure.message;
}

/** `m:ss`, the resend countdown of the mockup. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
