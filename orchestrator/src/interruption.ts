/**
 * Qualifying why a mission died.
 *
 * WHY: until this existed, a mission killed in flight (account usage limit,
 * external kill, crash + orchestrator restart) left its task BLOCKED with an
 * EMPTY `blocked_reason` — indistinguishable from a real business block posted
 * by the agent via `rooks task block --reason "..."`. Every incident meant
 * cross-checking mission timestamps against the Kanban by hand to understand
 * what had happened (incident of 2026-07-30: 3 silent BLOCKED tasks, in fact
 * the usage limit).
 *
 * So we separate two families, carried by two distinct columns:
 *   - `tasks.interrupted_reason`: SYSTEM death. Written by the orchestrator
 *     only, never by the agent.
 *   - `tasks.blocked_reason`: the BUSINESS reason when the agent closes out
 *     itself. On a system death we also write a readable sentence there (cf.
 *     `describeInterruption`) so the Kanban stays understandable without an SQL
 *     query, but `interrupted_reason` is what settles which family it is.
 */

export const INTERRUPTION_REASONS = [
  'rate_limit',
  'exhausted',
  'backend_unavailable',
  'overloaded',
  'permission_denied',
  'killed',
  'stopped',
  'timeout',
  'turn_budget',
  'crash',
  'unknown',
] as const;

export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number];

export function isInterruptionReason(v: unknown): v is InterruptionReason {
  return typeof v === 'string' && (INTERRUPTION_REASONS as readonly string[]).includes(v);
}

/** Defensive read of a value coming from SQLite (free TEXT column). */
export function toInterruptionReason(v: unknown): InterruptionReason | null {
  return isInterruptionReason(v) ? v : null;
}

const LABELS: Record<InterruptionReason, string> = {
  rate_limit: 'account usage limit reached',
  // Distinct from `rate_limit`, and not as a nuance: a quota window reopens on
  // its own, an empty balance does not. Conflating them wrote "quota reopens at
  // HH:MM" (or "time not reported") to the Kanban for an account only a top-up
  // will bring back — a reason that invites waiting for a reopening that will
  // never come (incident of 2026-09-01).
  exhausted:
    'account out of credit (HTTP 402) — nothing reopens on its own, '
    + 'it has to be topped up. The series fallback takes over',
  // Verdict of the circuit breaker (`backend-breaker.ts`): we do NOT know what
  // is wrong with the backend, only that it returns every mission in under two
  // seconds having produced nothing. Naming the cause "crash" would have
  // replayed the task into the same wall (night of 2026-09-01, 4 respawns).
  backend_unavailable:
    'backend structurally unavailable — the CLI reported an authentication '
    + 'failure, or several missions returned instantly without producing a '
    + 'single turn (expired login, no credit left, dead endpoint). The series '
    + 'fallback takes over',
  // Distinct from `rate_limit`: one model is full for a few minutes, the
  // account is fine. Hence no backend cooldown and no series switchover — the
  // dispatcher moves THIS task onto its fallback plan and replays it.
  overloaded:
    'the provider reported the model at capacity (overloaded) — transient; the task '
    + 'moves to its fallback backend when one exists, otherwise it is replayed later',
  permission_denied:
    'permission denied on a tool use (the CLI stops dead, the task is not closed out)',
  killed: 'process killed (manual stop or idle-mission reap)',
  // Distinct from `killed`: a human cut THIS turn from the chat, knowing the
  // conversation stays alive. Conflating the two would replay the task (killed
  // is replayable) when the interruption is precisely how one takes it back in
  // hand.
  stopped: 'turn stopped by hand from the chat (the conversation stays resumable)',
  timeout: 'turn silent too long — no output from the agent within the hung threshold (hung reap)',
  // Distinct from `timeout`: the agent was still talking, the turn simply ran
  // past `ROOKS_REAP_TURN_MAX_MS`. Calling that "hung" sent people looking for
  // a frozen process that never existed (TIM-0094).
  turn_budget: 'turn ran past its duration budget while still active (turn budget reap)',
  crash: 'unexpected stop of the process or of the orchestrator',
  unknown:
    'undetermined cause — the process died without closing the task out and its '
    + 'stream yielded no usable signal',
};

/**
 * Optional detail alongside the cause, when we know it (cf.
 * `dbApi.detectMissionDeathSignal`). On a usage limit, `resetsAt` is the
 * operational bit: it says at what time to retry.
 */
export type InterruptionDetail = {
  /** Quota window concerned, as reported by the provider (e.g. 'five_hour'). */
  rateLimitType?: string | null;
  /** Quota reopening, in epoch MILLISECONDS (the provider sends seconds — the
   *  conversion happens when the events are read). */
  resetsAt?: number | null;
};

/** 24-hour local time. `en-GB` and not `en-US`, whose 12-hour clock would put
 *  "02:05 PM" in a machine-readable reason. */
function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Readable sentence written to `blocked_reason`, for a human OR an
 * orchestrator. Formatted in local time: on a usage limit, the time is what
 * tells you when to retry.
 */
export function describeInterruption(
  reason: InterruptionReason,
  at: number = Date.now(),
  detail?: InterruptionDetail,
): string {
  let label = LABELS[reason];
  if (reason === 'rate_limit') {
    // The window type and the reopening time come out in the open: that is what
    // makes the reason actionable without an SQL query, and it tells a pilot or a
    // human there is nothing to restart by hand (`requeueBackendBlockedTasks`).
    // When the dialect does not expose them (`rateLimitReporting: 'textual'`), we WRITE that they are
    // unknown: a truncated reason reads as information missing by oversight,
    // and sends people looking in the logs for data that does not exist.
    label += detail?.rateLimitType ? ` (${detail.rateLimitType})` : ' (unknown window)';
    label += detail?.resetsAt
      ? `, quota reopens at ${hhmm(detail.resetsAt)}, the task restarts on its own after that`
      : ', reopening time not reported by the backend';
  }
  return `Mission interrupted (${reason}): ${label} — observed at ${hhmm(at)}. `
    + `This is NOT a business block: the task was never closed out by the agent.`;
}

/**
 * System death causes we automatically requeue instead of leaving the task
 * BLOCKED.
 *
 * WHY this subset and not all of them: a task left BLOCKED stays stuck until a
 * human sees it — the failure mode we are eliminating (night of 2026-08-15: 3
 * doc tasks killed by the idle-mission reap, restarted by hand the next day).
 * But not every cause replays:
 *   - `rate_limit` and `exhausted`: restarting immediately would land back in
 *     the same closed quota, or the same dry account. They leave once they
 *     can: when their series moves onto its fallback (`requeueRateLimitedTasks`),
 *     or, series or not, when their backend reopens or a fallback is workable
 *     (`requeueBackendBlockedTasks`, dispatcher.ts, TODO #520). Listing them
 *     here would have them hammer a backend we already know will return nothing.
 *   - `permission_denied`: replaying identically gets refused identically. It
 *     takes a human decision.
 *   - `unknown`: undetermined cause, so nothing says a restart changes
 *     anything. We stay conservative and surface the task.
 *   - `stopped`: a human cut the turn, knowingly. Replaying it identically
 *     would redo exactly what they just stopped — the task is waiting on their
 *     decision (restart, corrected brief, abandon).
 *   - `turn_budget`: the turn was alive and working for hours. Replaying it
 *     identically would most likely burn the same budget again, up to
 *     `MAX_SYSTEM_REQUEUES` times over.
 */
const REQUEUEABLE: readonly InterruptionReason[] = ['killed', 'timeout', 'crash', 'overloaded'];

export function isRequeueableInterruption(reason: InterruptionReason): boolean {
  return REQUEUEABLE.includes(reason);
}

/**
 * Delay before replaying a task requeued after a system death.
 *
 * WHY (night of 2026-09-01). The backend returned every mission in 295 ms; the
 * task left three times in three minutes — 21:17, 21:18, 21:19 — for three
 * identical deaths. With no wait, automatic requeuing becomes hammering: the
 * more instant a cause is, the faster we replay it, which is exactly backwards.
 *
 * The doubling gives the outside world time to change state (a service
 * restarting, a token refreshing) without ever exceeding a quarter of an hour:
 * beyond that, with a ceiling of 3 requeues, the task would sleep longer than a
 * human takes to see it.
 *
 * These values are constants and not settings, like `MAX_SYSTEM_REQUEUES` whose
 * counterpart they are: both bound the same loop, and tuning them separately
 * would make no sense.
 */
export const REQUEUE_BACKOFF_BASE_MS = 2 * 60_000;
export const REQUEUE_BACKOFF_MAX_MS = 15 * 60_000;

/** Delay before the Nth attempt (N >= 1): 2 min, 4 min, 8 min... capped. */
export function requeueBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  // 2 ** (n - 1) bounded before the multiplication: an aberrant counter in the
  // database must not produce an Infinity that would write an incoherent
  // `scheduled_at`.
  const factor = Math.min(2 ** Math.min(n - 1, 20), REQUEUE_BACKOFF_MAX_MS);
  return Math.min(REQUEUE_BACKOFF_MAX_MS, REQUEUE_BACKOFF_BASE_MS * factor);
}

/**
 * Wait past the reopening a provider announced before a task it stopped leaves
 * again (TIM-0134). The time is the provider's and the clock is ours: leaving on
 * the announced second risks falling on the limit one last time, and a task
 * that does so wakes its pilot for nothing.
 */
export const QUOTA_REOPEN_MARGIN_MS = 2 * 60_000;

/**
 * Causes that say "the work did not fail, the backend shut down" — hence the
 * ones that must switch the WHOLE series over to its fallback plan, pilot
 * included (cf. `switchSeriesToFallback`).
 *
 * Three members, one single consequence: `rate_limit` (the provider said so),
 * `exhausted` (it answered 402: the account is dry) and `backend_unavailable`
 * (the circuit breaker deduced it without reading anything). On the night of
 * 2026-09-01 only the first existed, and the provider's vocabulary matched no
 * known reason: the series kept hammering a backend with no credit until a
 * human moved it by hand.
 *
 * These three causes must stay aligned with the filter in
 * `requeueRateLimitedTasks` (`db.ts`): a cause that switches the series over
 * without being requeued leaves the task BLOCKED on an already-applied fallback
 * plan — the work is movable, nobody moves it.
 */
export const BACKEND_FALLBACK_REASONS: readonly InterruptionReason[] = [
  'rate_limit',
  'exhausted',
  'backend_unavailable',
];

export function triggersBackendFallback(reason: InterruptionReason): boolean {
  return BACKEND_FALLBACK_REASONS.includes(reason);
}

/**
 * Deaths that say something about the TASK, hence the ones a crash loop is
 * counted from (TIM-0065). Left out: a backend outage, whose task is moved and
 * requeued by the series switchover (a long quota outage would otherwise
 * exhaust every task of the series), and `stopped`, which a human chose.
 */
export function countsTowardCrashLoop(reason: InterruptionReason): boolean {
  return !triggersBackendFallback(reason) && reason !== 'stopped';
}
