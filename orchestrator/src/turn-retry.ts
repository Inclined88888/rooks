/**
 * A turn that failed because the provider could not be reached is not a turn
 * that failed (TODO #459). This module decides which failures are transient and
 * how many times Timon replays the turn of an unattended mission; `agent.ts`
 * carries the decision out.
 *
 * Two layers of retries, never confused:
 *  - the PROVIDER's own (codex reconnects 5 times, claude retries its API call):
 *    reported as `provider_retry` events while the turn goes on;
 *  - TIMON's, once the provider has given up: the same turn is replayed in the
 *    same session, at most `TIMON_TURN_RETRIES` times, only on a mission nobody
 *    watches. A human chat gets a Retry button instead — a turn replayed behind
 *    the user's back could send a message twice.
 *
 * Pure: no database, no bus, no process. Exported for tests.
 */

export type TurnFailureClass = 'transient' | 'fatal';

export type TurnFailureInput = {
  /** What the failed `result` says (`resultFailureText`). */
  error: string;
  /** HTTP status the provider attached, when it did. */
  apiErrorStatus?: number | null;
  /** `provider_retry` events seen during this turn. */
  providerRetries: number;
  /** A quota wall `rate-limit.ts` recognised: the fallback owns it. */
  rateLimited: boolean;
  /** The CLI reported it could not authenticate. */
  authFailed: boolean;
  /** We cut the turn ourselves (stop, reap, reload, backend switch). */
  interrupted: boolean;
};

/** Requests the provider refused for what they ARE: replaying them changes nothing. */
const FATAL_STATUS = new Set([400, 401, 402, 403, 404, 413, 422]);
const FATAL_TEXT = new RegExp([
  String.raw`\b40[0-4]\b`, String.raw`\b41[03]\b`, String.raw`\b422\b`,
  'unauthori[sz]ed', 'forbidden', 'authentication', 'not (?:logged|signed) in', 'please (?:log|sign) in',
  'invalid[ _-]?api[ _-]?key', 'invalid[ _-]?request', 'prompt is too long', 'context (?:length|window)',
  'maximum context', 'permission denied',
].join('|'), 'i');

/** The provider, or the road to it, was down for a moment. */
const TRANSIENT_TEXT = new RegExp([
  'stream disconnected', 'websocket', 'connection (?:reset|refused|closed|error|lost|aborted)',
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH',
  'EHOSTUNREACH', 'ENOTFOUND', 'socket hang up', 'network', 'timed? ?out', 'fetch failed',
  'overloaded', 'at capacity', 'internal server error', 'bad gateway', 'service unavailable', 'gateway timeout',
  'server[ _-]?error', String.raw`\b5\d\d\b`, 'retr(?:y|ies) (?:limit|exhausted)', 'exceeded retry',
  String.raw`^Reconnecting\.\.\.`, 'temporarily unavailable', 'try again later',
].join('|'), 'i');

/**
 * Transient or fatal, whatever the provider. Prudent by construction: a failure
 * nothing identifies stays FATAL, unless the provider had itself been retrying
 * during the turn — its giving up is then the end of a series of transport
 * failures, not a refusal.
 */
export function classifyTurnFailure(input: TurnFailureInput): TurnFailureClass {
  if (input.interrupted || input.rateLimited || input.authFailed) return 'fatal';
  const status = input.apiErrorStatus;
  if (typeof status === 'number') {
    if (FATAL_STATUS.has(status) || status === 429) return 'fatal';
    if (status === 408 || (status >= 500 && status < 600)) return 'transient';
  }
  const text = input.error;
  if (FATAL_TEXT.test(text)) return 'fatal';
  if (TRANSIENT_TEXT.test(text)) return 'transient';
  return input.providerRetries > 0 ? 'transient' : 'fatal';
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** True for a `result` that closes its turn on a failure. */
export function isFailedResult(payload: unknown): boolean {
  const p = record(payload);
  if (!p) return false;
  return p.is_error === true || (typeof p.subtype === 'string' && p.subtype.startsWith('error'));
}

/** The words of a failed `result`, wherever the dialect put them. */
export function resultFailureText(payload: unknown): string {
  const p = record(payload);
  if (!p) return '';
  const parts: string[] = [];
  if (typeof p.error === 'string') parts.push(p.error);
  if (typeof p.result === 'string') parts.push(p.result);
  if (Array.isArray(p.errors)) {
    for (const e of p.errors) {
      if (typeof e === 'string') parts.push(e);
      else if (typeof record(e)?.message === 'string') parts.push(record(e)!.message as string);
    }
  }
  return parts.map((s) => s.trim()).filter(Boolean).join(' — ');
}

/** Retries the provider reported, read off the stream. */
export type ProviderRetryTally = {
  count: number; max: number | null; lastCause: string | null;
  /** The wait the provider announced last: Timon's replay never undercuts it. */
  lastDelayMs: number | null;
};

export function tallyProviderRetry(tally: ProviderRetryTally | undefined, payload: unknown): ProviderRetryTally {
  const p = record(payload);
  const max = typeof p?.max === 'number' ? p.max : tally?.max ?? null;
  const cause = typeof p?.cause === 'string' && p.cause ? p.cause : tally?.lastCause ?? null;
  const delay = typeof p?.delay_ms === 'number' ? p.delay_ms : tally?.lastDelayMs ?? null;
  return { count: (tally?.count ?? 0) + 1, max, lastCause: cause, lastDelayMs: delay };
}

/** Wait before Timon's attempt `attempt` (1-based): base, ×2, ×4… and never
 *  shorter than the wait the provider itself announced last. */
export function turnRetryDelayMs(attempt: number, baseMs: number, providerDelayMs?: number | null): number {
  const base = Math.max(0, baseMs) * 2 ** Math.max(0, attempt - 1);
  return Math.max(base, typeof providerDelayMs === 'number' && providerDelayMs > 0 ? providerDelayMs : 0);
}

/** Fields a failed `result` carries once judged transient. Snake case, like
 *  the rest of the persisted vocabulary. */
export type TransientFailureFields = {
  transient_failure: {
    cause: string;
    provider_retries: number;
    provider_max: number | null;
    /** Timon's retries already spent on this turn. */
    timon_retries: number;
    timon_max: number;
  };
  /** Present when Timon replays the turn: the turn is NOT over. */
  timon_retry?: { attempt: number; max: number; delay_ms: number };
};

/** The prompt that replays a turn in the session that holds it. The request
 *  is already in the conversation: sending it again would show it twice. */
export function turnRetryPrompt(attempt: number, max: number, cause: string): string {
  return `Your previous turn was cut by a transient provider error (${cause.slice(0, 300)}). `
    + `This is Timon's automatic retry ${attempt}/${max}: resume the latest request above where you left off `
    + 'and finish it. Do not redo actions that already completed (files written, messages sent, tasks created).';
}

/** What the agent waiting on a request reads when the provider never came back. */
export function transientFailureReply(fields: TransientFailureFields['transient_failure'] | null): string {
  if (!fields) return 'The recipient could not complete this request: its provider was unreachable (transient). Retry later.';
  const timon = fields.timon_retries > 0 ? ` + ${fields.timon_retries} Timon retr${fields.timon_retries === 1 ? 'y' : 'ies'}` : '';
  return 'The recipient could not complete this request: its provider was unreachable (transient) after '
    + `${fields.provider_retries} provider retr${fields.provider_retries === 1 ? 'y' : 'ies'}${timon} — retry later. `
    + `Last error: ${fields.cause.slice(0, 300)}`;
}
