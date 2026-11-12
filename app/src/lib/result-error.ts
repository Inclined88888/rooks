/**
 * Reading the error message carried by a `result` event.
 *
 * The CLIs do not put it in the same place: claude sets a string on `error`,
 * grok an ARRAY on `errors`. Without reading both, a backend that only uses
 * the second form stops its missions without a word — that is what made an
 * exhausted grok quota completely silent in the chat.
 *
 * An asymmetry to know: claude announces its usage limits TWICE — an
 * `assistant` event (which the UI shows as a normal answer, hence the
 * impression that "Claude is answering") and this `result`. grok only emits
 * the second. The caller must therefore dedupe against the last message shown.
 */

/** Does the message announce an exhausted quota rather than a failure? A
 *  deliberately simplified mirror of `RATE_LIMIT_TEXT` (orchestrator/src/rate-limit.ts):
 *  the two packages share no code, and here the consequence is limited to the
 *  introductory word shown. */
const RATE_LIMIT_TEXT =
  /rate.?limit|quota|usage limit|session limit|too many requests|\b429\b/i;

export function isRateLimitMessage(text: string): boolean {
  return RATE_LIMIT_TEXT.test(text);
}

/**
 * The error message of a `result`, or null when the turn went well.
 *
 * `result` (the turn's final text) is read only as a last resort AND only when
 * it is short: on claude it holds the full answer, which would be spat out
 * again under the bubble that just showed it.
 */
export function resultErrorText(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.is_error !== true) return null;

  const parts: string[] = [];
  if (typeof p.error === 'string' && p.error.trim()) parts.push(p.error.trim());
  if (Array.isArray(p.errors)) {
    for (const e of p.errors) if (typeof e === 'string' && e.trim()) parts.push(e.trim());
  }
  if (!parts.length && typeof p.result === 'string') {
    const r = p.result.trim();
    if (r && r.length <= MAX_RESULT_FALLBACK) parts.push(r);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Beyond this, `result` is an agent's answer, not an error message. Calibrated
 *  on the CLIs' real wording ("You've hit your session limit · resets
 *  9:10pm (Europe/Paris)" is 58 characters). */
const MAX_RESULT_FALLBACK = 300;
