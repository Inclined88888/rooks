/**
 * Generic circuit breaker: N sterile turns in a row on the SAME backend mean
 * the backend is structurally unavailable, whatever it says about it.
 *
 * WHY THIS MODULE EXISTS (incident of 2026-09-01, grok). `rate-limit.ts` reads
 * what the provider says: a window, a status, a sentence. That works only for
 * the vocabularies we already know. The night the Grok account ran out of
 * credit, four missions died in ~295 ms each, 0 turn, 0 token, and nothing in
 * TIMON noticed — the sentence ("Grok Build usage balance exhausted") matched
 * no pattern of the day. fb-1 taught the module that sentence; this one makes
 * the sentence unnecessary.
 *
 * The signature we act on carries no words at all:
 *
 *   result · is_error · num_turns ≤ 1 · 0 token · duration_ms < ~2 s
 *
 * A CLI that answers that fast, having produced nothing, did not work: it
 * bounced off its provider. Broken auth (`Not signed in` after a token
 * refresh overwrote `auth.json`), an account with no credit, a dead endpoint —
 * the cause is unknown and does not matter here. Repeated N times in a row,
 * the only reasonable conclusion is "do not send anything else there for a
 * while", which is exactly what a cooldown says.
 *
 * DELIBERATELY STRICT on what counts as sterile, because a false positive
 * sidelines a healthy backend for the whole account:
 *   - `num_turns` must be EXPLICITLY reported, and at most 1. A dialect that
 *     does not report the field must never look like a backend that produced
 *     nothing. 1 is accepted because the claude CLI counts the turn it OPENED,
 *     not the turn it got an answer to: its expired-OAuth bounce reports
 *     `num_turns: 1` after 45 ms and 0 token (night of 2026-09-17, 8 missions
 *     the breaker never counted). A 1 only counts with an explicit `usage`
 *     block, so the zero tokens are observed, not assumed.
 *   - same for `duration_ms`: absent is not "fast".
 *   - any token or any cost proves the provider did work, so the turn is
 *     productive however it ended.
 *   - `is_error` must be true. A sterile SUCCESS says nothing about the
 *     backend's health, and we would rather miss one than exclude a
 *     functioning provider.
 *
 * The counter is deliberately IN MEMORY, unlike the cooldown it produces
 * (`backend_cooldowns`, in the database). What it counts is a burst — three
 * bounces inside the same sliding window — and an orchestrator restart breaks
 * exactly that continuity: two failures observed before a restart no longer
 * say anything about what happens after it.
 */
import { settingBool, settingInt } from './settings.js';

/** Why a trip fired. `burst` is the historical verdict — N shapeless bounces
 *  inside the window. `auth` is the CLI saying, in a structured field, that it
 *  could not authenticate: that one does not heal on its own. */
export type BreakerCause = 'burst' | 'auth';

/** A trip: the moment the count crosses the threshold, and everything needed
 *  to explain WHY afterwards. A breaker that fires without saying why is
 *  undebuggable, which is half the point of this module. */
export type BreakerTrip = {
  backend: string;
  /** Sterile turns counted inside the window, threshold included. */
  failures: number;
  threshold: number;
  windowMs: number;
  /** Age of the oldest failure still counted — how fast the burst happened. */
  spanMs: number;
  /** The last observed signature, in plain words (`0 turn / 0 token / 295 ms`). */
  signature: string;
  cause: BreakerCause;
};

/** Sliding window of sterile turns, per backend. */
const failures = new Map<string, { at: number; signature: string }[]>();

/** Backends that produced at least one turn since the daemon started. A
 *  backend that never did and bounces is far more likely mis-set-up (login,
 *  CLI version, missing binary — the whole first-run story of TIM-0009) than
 *  structurally down: its exclusion must be short enough to retry after the
 *  fix, not the half-hour a proven backend earns. */
const proven = new Set<string>();

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Longest a turn may last and still count as a bounce. */
function sterileMs(): number {
  return Math.max(1, settingInt('TIMON_BREAKER_STERILE_MS'));
}

/**
 * Signature of a sterile `result` event, or null if the turn does not have
 * that shape. Pure: reads the event, touches no state.
 */
export function sterileResultSignature(type: string, payload: unknown): string | null {
  if (type !== 'result') return null;
  const p = asRecord(payload);
  if (!p || p.is_error !== true) return null;
  if (p.num_turns !== 0 && p.num_turns !== 1) return null;
  if (typeof p.duration_ms !== 'number' || p.duration_ms >= sterileMs()) return null;
  const usage = asRecord(p.usage);
  if (p.num_turns === 1 && !usage) return null;
  const tokens = num(usage?.input_tokens) + num(usage?.output_tokens);
  if (tokens > 0 || num(p.total_cost_usd) > 0) return null;
  return `${p.num_turns} turn / 0 token / ${Math.round(p.duration_ms)} ms`;
}

/**
 * Error codes a CLI attaches, as a STRUCTURED field, to the message it
 * synthesises when the provider refused to authenticate it. Read as a code,
 * never as a sentence: the claude CLI puts `error: "authentication_failed"`
 * on its `<synthetic>` assistant message, next to a human text we ignore.
 */
const AUTH_FAILURE_CODES: ReadonlySet<string> = new Set(['authentication_failed']);

/**
 * True when this event is the CLI reporting that it could not authenticate.
 * Pure. On its own it proves nothing about the turn — it is only acted on when
 * the turn's `result` is ALSO sterile (cf. `agent.ts`), so a model merely
 * talking about authentication can never trip anything.
 */
export function isAuthFailureEvent(type: string, payload: unknown): boolean {
  if (type !== 'assistant') return false;
  const p = asRecord(payload);
  return typeof p?.error === 'string' && AUTH_FAILURE_CODES.has(p.error);
}

/**
 * Signature of a process that died mid-turn without ever emitting a `result`,
 * or null when the turn lasted long enough to have done something.
 *
 * Same family as above, one step earlier: a CLI whose endpoint is dead can
 * exit before writing a single line of its stream. Without this the breaker
 * would only cover the backends polite enough to report their own failure.
 */
export function sterileExitSignature(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs >= sterileMs()) return null;
  return `no result / ${Math.round(durationMs)} ms`;
}

/**
 * Records a sterile turn and returns the trip once the threshold is reached.
 *
 * Returns a trip on EVERY sterile turn from the threshold on, not only on the
 * exact crossing: the caller uses it to qualify the death of THIS mission, and
 * the fourth mission to bounce deserves the same qualification as the third.
 * Idempotence belongs to the cooldown that consumes the trip, not here.
 */
export function noteSterileTurn(
  backend: string | null | undefined,
  signature: string,
  now: number = Date.now(),
  cause: BreakerCause = 'burst',
): BreakerTrip | null {
  if (!backend || !settingBool('TIMON_BREAKER_ENABLED')) return null;
  const windowMs = Math.max(1000, settingInt('TIMON_BREAKER_WINDOW_MS'));
  // A minimum of 2 for a shapeless bounce: it is a fluke until it repeats, and
  // a threshold of 1 would sideline a backend on the first hiccup of a free
  // tier. An authentication failure trips at 1, for two reasons. It is not
  // inferred from a shape, the CLI states it in a structured field. And it does
  // not heal: an expired OAuth session waits for a human to log in again, so
  // every retry is a mission lost for nothing. Counting to 3 also presumed the
  // bounces came fast; on 2026-09-17 each mission waited out the idle reaper
  // (10 min) before dying, and a window of 10 min never held more than one.
  const threshold = cause === 'auth' ? 1 : Math.max(2, settingInt('TIMON_BREAKER_THRESHOLD'));
  const kept = (failures.get(backend) ?? []).filter((f) => now - f.at < windowMs);
  kept.push({ at: now, signature });
  failures.set(backend, kept);
  if (kept.length < threshold) return null;
  return {
    backend,
    failures: kept.length,
    threshold,
    windowMs,
    spanMs: now - kept[0]!.at,
    signature,
    cause,
  };
}

/** A turn that got somewhere: the burst is broken, the count starts over.
 *  Called on every productive turn, so a backend that hiccups once an hour
 *  never accumulates its way to an exclusion. */
export function noteProductiveTurn(backend: string | null | undefined): void {
  if (!backend) return;
  failures.delete(backend);
  proven.add(backend);
}

/** Whether this backend has produced a single turn since the daemon started. */
export function hasProvenTurn(backend: string | null | undefined): boolean {
  return !!backend && proven.has(backend);
}

/** Sterile turns currently counted for this backend (debug, tests, UI). */
export function breakerFailures(backend: string, now: number = Date.now()): number {
  const windowMs = Math.max(1000, settingInt('TIMON_BREAKER_WINDOW_MS'));
  return (failures.get(backend) ?? []).filter((f) => now - f.at < windowMs).length;
}

/** Forgets the burst counted for one backend: an account that was just signed
 *  in again must not trip on the bounces of its previous, signed-out life. */
export function resetBreaker(backend: string): void {
  failures.delete(backend);
}

/** Forgets everything. Only for tests and for a deliberate operator reset. */
export function resetBreakers(): void {
  failures.clear();
  proven.clear();
}
