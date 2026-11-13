/**
 * Parsing of the verdict of a `review` task (done_comment → pass / changes_requested
 * / unknown).
 *
 * A separate module WITHOUT runtime imports: this parser is consumed both by
 * the verification-loop (which decides on a code respawn or a merge) and by the
 * dispatcher (dispatch gate of pre-created merge tasks). Moving it out of
 * `verification-loop.ts` avoids creating an import cycle there and allows
 * testing it without opening the SQLite database.
 */

export type Verdict = 'pass' | 'changes_requested' | 'unknown';
export type ParsedReview = { verdict: Verdict; feedback: string | null };

/** Normalises a verdict token, tolerating the common synonyms a
 *  reviewer may produce despite the contract (approved/lgtm = pass;
 *  request(s)_changes / needs_changes / changes_needed = changes_requested).
 *  Reduces the number of `unknown` verdicts (which stall the chain). */
function normalizeVerdict(raw: unknown): Verdict {
  const v = String(raw ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (v === 'pass' || v === 'approved' || v === 'approve' || v === 'lgtm' || v === 'ok') return 'pass';
  if (
    v === 'changes_requested' || v === 'request_changes' || v === 'requests_changes' ||
    v === 'needs_changes' || v === 'changes_needed' || v === 'rejected' || v === 'reject'
  ) {
    return 'changes_requested';
  }
  return 'unknown';
}

/** Tries to extract structured feedback (`suggested_fixes`/`findings`) from a
 *  JSON block present in the comment, even if the JSON is truncated: first a
 *  strict parse, then a minimal repair (closing the open
 *  braces/brackets). Returns null if nothing usable. */
function extractJsonFeedback(comment: string): string | null {
  const start = comment.indexOf('{');
  if (start < 0) return null;
  const candidate = comment.slice(start);
  for (const text of [candidate, repairTruncatedJson(candidate)]) {
    if (!text) continue;
    try {
      const j = JSON.parse(text) as { suggested_fixes?: unknown; findings?: unknown };
      const fix = typeof j.suggested_fixes === 'string' && j.suggested_fixes.trim()
        ? j.suggested_fixes.trim() : null;
      const find = Array.isArray(j.findings)
        ? j.findings.map((f) => `- ${typeof f === 'string' ? f : JSON.stringify(f)}`).join('\n')
        : null;
      if (fix ?? find) return fix ?? find;
    } catch { /* try the repaired variant, then give up */ }
  }
  return null;
}

/** Closes the strings/arrays/objects left open by a truncation, to
 *  make a partial JSON parsable "best effort". Ignores braces
 *  inside strings. Returns null if there is nothing to repair (already balanced). */
function repairTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let escaped = false;
  for (const ch of text) {
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (!inStr && stack.length === 0) return null;
  let out = text;
  if (inStr) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  return out;
}

/**
 * Extracts the verdict from a review done_comment. Robust to truncation
 * (broken shell arg, the model's max_tokens, etc.): the contract now requires
 * a plain 1st line `verdict: pass|changes_requested`, which survives
 * any cut of the optional JSON that follows. Order of attempts:
 *   1. a `verdict:` token anywhere in the text (tolerant regex) — covers
 *      the plain 1st line AND a verdict inline in the JSON;
 *   2. strict JSON if the comment starts with `{` (legacy / rich feedback);
 *   3. otherwise `unknown` → the chain escalates (BLOCKED + notify).
 * The `changes_requested` feedback is taken from the JSON (repaired if truncated) then,
 * failing that, from the raw text.
 */
export function parseReviewVerdict(comment: string | null): ParsedReview {
  if (!comment) return { verdict: 'unknown', feedback: null };
  const trimmed = comment.trim();

  // 1. Plain verdict token, anywhere (1st line of the new contract, or
  //    inline in a JSON, even truncated, as long as the key survives).
  // `"?` before the separator tolerates the JSON key form `"verdict":` (closing
  // quote between the word and the `:`) as much as the free form `verdict:`.
  const m = /verdict\s*"?\s*[:=]\s*"?(pass|approved?|lgtm|ok|changes[ _-]?requested|requests?[ _-]?changes|needs[ _-]?changes|changes[ _-]?needed|rejected?)"?/i.exec(comment);
  if (m) {
    const v = normalizeVerdict(m[1]);
    if (v === 'pass') return { verdict: 'pass', feedback: null };
    if (v === 'changes_requested') {
      const fbMatch = /suggested[ _-]?fixes\s*[:=]\s*([\s\S]+?)(?:\n\s*\n|$)/i.exec(comment);
      return {
        verdict: 'changes_requested',
        feedback: extractJsonFeedback(comment) ?? (fbMatch ? fbMatch[1]!.trim() : trimmed),
      };
    }
  }

  // 2. Strict JSON (legacy 100% JSON comment without an isolated verdict line).
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { verdict?: unknown };
      const v = normalizeVerdict(j.verdict);
      if (v === 'pass') return { verdict: 'pass', feedback: null };
      if (v === 'changes_requested') {
        return { verdict: 'changes_requested', feedback: extractJsonFeedback(comment) ?? trimmed };
      }
    } catch { /* broken JSON and no recoverable verdict token → unknown */ }
  }

  return { verdict: 'unknown', feedback: null };
}
