/**
 * Chunk-boundary-safe redaction for the live `assistant_delta` stream
 * (`docs/SECRETS-VAULT.md` §7.1).
 *
 * `redactText` masks a value only when it appears whole inside the string it
 * is given. A streamed answer arrives in fragments cut wherever the CLI
 * happened to flush, so a token straddling two chunks (`…sk-live-abc` +
 * `defghijkl…`) matches neither fragment and flashes through the SSE wire in
 * the clear. The persisted event is masked correctly, but "it is only on the
 * live wire" is not a defence: that wire is what the browser renders, what a
 * screen recording captures, and what a plugin listening on the bus receives.
 *
 * Protocol — report of the only ambiguous suffix, per mission:
 *
 *  1. `texte = report + fragment`
 *  2. Mask every complete occurrence in `texte`.
 *  3. The longest suffix of `texte` that is a *strict* prefix of a known
 *     value becomes the new `report`; everything else is emitted now.
 *  4. No such suffix → `report` is empty and the fragment goes out whole.
 *
 * Step 4 is what makes this acceptable: in the common case — no partial match
 * — nothing is deferred and the stream keeps its former latency. Only a
 * fragment that ends on the start of a secret is held, until the next one.
 *
 * `report` cannot exceed the longest value minus one: beyond that it cannot
 * be a prefix of anything. There is no second, shorter ceiling — a bound that
 * silently dropped the tail of a long value (a PEM key) would let the rest of
 * that value through on the next chunk.
 *
 * End of turn: whatever is still held is a secret prefix (or a false-positive
 * one), so it is replaced with `***` before it is emitted. End of mission:
 * the entry is dropped without being emitted — a missing tail is better than
 * a leak.
 */

import { REDACTION_PLACEHOLDER, redactText, redactedValues } from './redact.js';

/** missionId → ambiguous suffix held back, waiting for the next chunk. Only
 *  missions whose last fragment ended on a strict prefix of a vault value
 *  have an entry. */
const held = new Map<string, string>();

/**
 * Longest suffix of `text` that is a strict prefix of one of `values`.
 * Empty string when nothing is ambiguous — the caller then emits `text`
 * whole, which is the hot path.
 */
function ambiguousSuffix(text: string, values: readonly string[]): string {
  let best = '';
  for (const value of values) {
    // A strict prefix is shorter than the value itself.
    const limit = Math.min(text.length, value.length - 1);
    for (let n = limit; n > best.length; n--) {
      if (value.startsWith(text.slice(text.length - n))) {
        best = text.slice(text.length - n);
        break;
      }
    }
  }
  return best;
}

/**
 * Feed one fragment, get back what is safe to put on the wire. May return the
 * empty string: a fragment that is itself a strict prefix is retained whole,
 * and the caller must then publish nothing rather than an empty delta.
 *
 * `mode: 'replace'` carries a full snapshot rather than an increment, so
 * stitching it onto the previous report would duplicate text. The previous
 * report is dropped and the snapshot is masked on its own; a value split
 * across two snapshots is whole in the later one. The snapshot's own
 * ambiguous suffix is still held, in case the next fragment is an `append`.
 */
export function redactStreamChunk(missionId: string, text: string, mode: 'append' | 'replace'): string {
  const values = redactedValues();
  if (!values.length) {
    // Vault empty. Anything still held was a prefix of a value that is no
    // longer in the index: emitting it in the clear would leak that prefix,
    // so it is masked. The new fragment itself has nothing to match.
    const pending = held.get(missionId);
    if (pending === undefined) return text;
    held.delete(missionId);
    return REDACTION_PLACEHOLDER + text;
  }
  const incoming = mode === 'replace' ? text : (held.get(missionId) ?? '') + text;
  if (mode === 'replace') held.delete(missionId);
  const redacted = redactText(incoming);
  const report = ambiguousSuffix(redacted, values);
  if (report) held.set(missionId, report);
  else held.delete(missionId);
  return report ? redacted.slice(0, redacted.length - report.length) : redacted;
}

/**
 * End of turn: replace whatever is still held with the placeholder and
 * return it, so a turn that finished on a strict prefix never emits that
 * prefix in the clear. Empty string when nothing was pending.
 */
export function flushRedactStream(missionId: string): string {
  if (!held.has(missionId)) return '';
  held.delete(missionId);
  return REDACTION_PLACEHOLDER;
}

/**
 * End of mission: drop the entry without emitting it. A missing tail is
 * preferable to a leak (`docs/SECRETS-VAULT.md` §7.1).
 */
export function dropRedactStream(missionId: string): void {
  held.delete(missionId);
}

/** Number of missions currently holding a suffix. For tests and for anyone
 *  wondering whether this map can grow: it cannot beyond the running agents. */
export function heldStreamCount(): number {
  return held.size;
}
