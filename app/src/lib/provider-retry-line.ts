/**
 * The single line the chat shows while a provider retries a request, and what
 * it becomes once the series ends (TODO #459). One line per series, updated in
 * place at every attempt: five "retrying" rows would bury the answer.
 *
 * Fed by three persisted events (orchestrator/src/backends/types.ts,
 * orchestrator/src/turn-retry.ts):
 *  - `provider_retry`: the provider retries on its own, the turn goes on;
 *  - a `result` carrying `transient_failure` (and `nova_retry` when Rooks
 *    replays the turn of an unattended mission);
 *  - `turn_retry_abandoned`: the replay never ran.
 */
import { t as i18n } from './i18n';

export type RetryLineState = 'retrying' | 'replaying' | 'recovered' | 'exhausted';

export type RetryLine = {
  state: RetryLineState;
  /** Display name of the backend, frozen when the series began. */
  provider: string;
  attempt: number | null;
  max: number | null;
  /** The provider's own words for what it retries, shown small underneath. */
  cause: string;
  /** Provider attempts seen in this series. */
  providerRetries: number;
  /** Rooks's replay under way or scheduled (unattended missions only). */
  rooks?: { attempt: number; max: number; delayMs: number | null };
  /** Rooks replays already spent when the series ended. */
  novaRetries?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A series is over once it recovered or gave up: the next retry opens a new line. */
export function retryLineOpen(line: RetryLine | null): line is RetryLine {
  return !!line && (line.state === 'retrying' || line.state === 'replaying');
}

/** A `provider_retry` event: the provider tries again, the turn goes on. */
export function lineOnProviderRetry(prev: RetryLine | null, payload: unknown, provider: string): RetryLine {
  const p = record(payload) ?? {};
  const open = retryLineOpen(prev) ? prev : null;
  return {
    state: 'retrying',
    provider: open?.provider ?? provider,
    attempt: count(p.attempt),
    max: count(p.max) ?? open?.max ?? null,
    cause: text(p.cause) || open?.cause || '',
    providerRetries: (open?.providerRetries ?? 0) + 1,
    ...(open?.rooks ? { rooks: open.rooks } : {}),
  };
}

/**
 * A `result`. Returns the line to show, or null when this result has nothing
 * to do with a retry (a plain failure keeps its usual notice).
 */
export function lineOnResult(prev: RetryLine | null, payload: unknown, provider: string): RetryLine | null {
  const p = record(payload);
  if (!p) return null;
  const failure = record(p.transient_failure);
  if (failure) {
    const replay = record(p.nova_retry);
    const base: RetryLine = {
      state: replay ? 'replaying' : 'exhausted',
      provider: retryLineOpen(prev) ? prev.provider : provider,
      attempt: retryLineOpen(prev) ? prev.attempt : null,
      max: count(failure.provider_max) ?? (retryLineOpen(prev) ? prev.max : null),
      cause: text(failure.cause) || (retryLineOpen(prev) ? prev.cause : ''),
      providerRetries: count(failure.provider_retries) ?? (retryLineOpen(prev) ? prev.providerRetries : 0),
      novaRetries: count(failure.nova_retries) ?? 0,
    };
    if (replay) {
      return {
        ...base,
        rooks: { attempt: count(replay.attempt) ?? 1, max: count(replay.max) ?? 1, delayMs: count(replay.delay_ms) },
      };
    }
    return base;
  }
  // The turn ended any other way: a success recovers the open series.
  if (!retryLineOpen(prev)) return null;
  const failed = p.is_error === true || (typeof p.subtype === 'string' && p.subtype.startsWith('error'));
  return failed ? { ...prev, state: 'exhausted' } : { ...prev, state: 'recovered' };
}

/** The agent spoke again: whatever the series was waiting for came back. */
export function lineOnOutput(prev: RetryLine | null): RetryLine | null {
  return retryLineOpen(prev) ? { ...prev, state: 'recovered' } : null;
}

/** Rooks's replay prompt reached the agent: the replay is now running. */
export function lineOnReplayStarted(prev: RetryLine | null, attempt: number, provider: string): RetryLine {
  const open = retryLineOpen(prev) ? prev : null;
  return {
    state: 'replaying',
    provider: open?.provider ?? provider,
    attempt: null,
    max: open?.max ?? null,
    cause: open?.cause ?? '',
    providerRetries: open?.providerRetries ?? 0,
    rooks: { attempt, max: open?.rooks?.max ?? attempt, delayMs: null },
  };
}

/** `turn_retry_abandoned`: the replay never ran, the turn ends on its failure. */
export function lineOnAbandoned(prev: RetryLine | null, payload: unknown, provider: string): RetryLine {
  const reason = text(record(payload)?.reason);
  const open = retryLineOpen(prev) ? prev : null;
  return {
    state: 'exhausted',
    provider: open?.provider ?? provider,
    attempt: null,
    max: open?.max ?? null,
    cause: open?.cause || reason,
    providerRetries: open?.providerRetries ?? 0,
    novaRetries: open?.rooks ? open.rooks.attempt - 1 : 0,
  };
}

/** The sentence of the line, and the small one underneath. */
export function retryLineText(line: RetryLine): { title: string; detail: string } {
  const provider = line.provider;
  const detail = line.cause;
  switch (line.state) {
    case 'retrying':
      return {
        title: line.attempt !== null && line.max !== null
          ? i18n('chatPage.providerRetrying', { provider, attempt: line.attempt, max: line.max })
          : i18n('chatPage.providerRetryingNoCount', { provider }),
        detail,
      };
    case 'replaying': {
      const rooks = line.rooks ?? { attempt: 1, max: 1, delayMs: null };
      return {
        title: rooks.delayMs !== null
          ? i18n('chatPage.novaRetryIn', { attempt: rooks.attempt, max: rooks.max, seconds: Math.max(1, Math.round(rooks.delayMs / 1000)) })
          : i18n('chatPage.novaRetryRunning', { attempt: rooks.attempt, max: rooks.max }),
        detail,
      };
    }
    case 'recovered': {
      const n = line.providerRetries + (line.rooks?.attempt ?? 0);
      return { title: n === 1 ? i18n('chatPage.providerRecoveredOne') : i18n('chatPage.providerRecovered', { count: n }), detail: '' };
    }
    case 'exhausted': {
      const rooks = line.novaRetries ?? 0;
      return {
        title: rooks > 0
          ? i18n('chatPage.providerExhaustedWithNova', { provider, count: line.providerRetries, rooks })
          : i18n('chatPage.providerExhausted', { provider, count: line.max ?? line.providerRetries }),
        detail,
      };
    }
  }
}
