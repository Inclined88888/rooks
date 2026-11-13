/**
 * Output redaction (`docs/SECRETS-VAULT.md` §7).
 *
 * The daemon knows every value in the vault, so it can mask them **before
 * storage** on everything it writes: agent transcripts, `log.jsonl`, SSE
 * events, a task's `done_comment`, a notification body. It is the complement of
 * injection (§6.1): since we accept that the agent sees the value, we at least
 * catch the most common accident — an `echo` too many, a token pasted into a
 * report, recopied into a commit, or carried away in a transcript sent
 * elsewhere.
 *
 * Two guards, both non-negotiable:
 *
 * - **Length threshold of 12 characters.** Below it we do not redact: a short
 *   secret would fire on ordinary prose and turn transcripts into a field of
 *   `***`, which costs more than it protects.
 * - **Cache invalidated on every vault write.** Otherwise redaction keeps
 *   working on stale values and lets the new one straight through — the exact
 *   moment a secret is most likely to be echoed back is right after it is set.
 *
 * Performance matters here: this filter is crossed by the whole output stream
 * of every agent, `event_delta` included (one call per chunk). Hence a plain
 * `includes` + `split`/`join` over a handful of values, no regexp built per
 * call, and an early return when the vault is empty — which is the common case.
 * Measured on a 400-character chunk over 200k iterations: **26 ns** per call
 * with an empty vault (the early return), **108 ns** against five loaded values
 * that do not match. Against a few hundred chunks per turn, that is noise.
 */

/** What replaces a value. Deliberately not a length-preserving mask: the length
 *  of a token is itself a hint about which token it is. */
export const REDACTION_PLACEHOLDER = '***';

/** §7: below this, redacting does more damage than it prevents. */
export const REDACTION_MIN_LENGTH = 12;

/** Where the plaintext values come from. Injected so this module stays pure and
 *  testable, and so it never has to import the database (which imports it). */
export type RedactionSource = () => Iterable<string>;

let source: RedactionSource | null = null;
let cache: readonly string[] | null = null;

/**
 * Register the vault as the value source. `db.ts` does this at import time, so
 * every process holding the database redacts — daemon and CLI alike.
 *
 * Returns the source it replaced, so a test can put the real one back without
 * having to know what it was.
 */
export function setRedactionSource(fn: RedactionSource | null): RedactionSource | null {
  const previous = source;
  source = fn;
  cache = null;
  return previous;
}

/**
 * Drop the memoised values. Called unconditionally on every vault write; we do
 * not try to work out whether the ciphertext actually moved, because being
 * wrong there means leaking the value we just stored.
 */
export function invalidateRedactionCache(): void {
  cache = null;
}

/** The values currently masked, longest first. Exported for tests and for the
 *  callers that want to know whether redaction is active at all. */
export function redactedValues(): readonly string[] {
  if (cache) return cache;
  const out: string[] = [];
  if (source) {
    const seen = new Set<string>();
    for (const value of source()) {
      if (typeof value !== 'string' || value.length < REDACTION_MIN_LENGTH) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    // Longest first: when one secret contains another (a bearer token holding a
    // shorter id, say), the containing one must be consumed whole, otherwise the
    // shorter match would leave the rest of the token visible around a `***`.
    out.sort((a, b) => b.length - a.length);
  }
  cache = Object.freeze(out);
  return cache;
}

/**
 * Mask every known value inside `text`. Returns the very same string instance
 * when nothing matched, so callers can use it on hot paths without allocating.
 */
export function redactText(text: string): string {
  const values = redactedValues();
  if (!values.length || !text) return text;
  let out = text;
  for (const value of values) {
    // `includes` before `split`: the overwhelming majority of chunks contain no
    // secret at all, and this way they cost one scan and zero allocation.
    if (!out.includes(value)) continue;
    out = out.split(value).join(REDACTION_PLACEHOLDER);
  }
  return out;
}

/** Guard against a pathological structure (a cycle would be a bug upstream, but
 *  redaction is not the place to discover it by hanging). */
const MAX_DEPTH = 12;

/**
 * Mask every string reachable in a structure, keys included — a payload
 * sometimes carries the value in a field name (`{ "AWS_SECRET…=abc": true }` in
 * a serialised env dump). Objects are rebuilt only where something changed, so
 * an untouched payload is returned by identity.
 *
 * Applied on the deserialised value rather than on its JSON, because a secret
 * containing a quote or a newline would not match its own escaped form.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (!redactedValues().length) return value;
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const red = redactDeep(item, depth + 1);
      if (red !== item) changed = true;
      return red;
    });
    return (changed ? next : value) as unknown as T;
  }
  // Anything that is not a plain object (Buffer, Date, class instance) is left
  // alone: rebuilding it would silently change its type on the way to storage.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const redKey = redactText(key);
    const redItem = redactDeep(item, depth + 1);
    if (redKey !== key || redItem !== item) changed = true;
    next[redKey] = redItem;
  }
  return (changed ? next : value) as unknown as T;
}

/** Convenience for the many `string | null` columns (`done_comment`, a
 *  notification body): keeps `null`/`undefined` as they are. */
export function redactNullable<T extends string | null | undefined>(text: T): T {
  return (typeof text === 'string' ? redactText(text) : text) as T;
}
