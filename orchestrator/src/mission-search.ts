/**
 * Full-text search in the mission history.
 *
 * Why this exists: until 2026-08-23, finding "the conversation where we
 * talked about X" was only possible by opening `~/.timon/timon.db` with sqlite3 and
 * typing a LIKE by hand on `events.payload` — 1.3 GB of JSON, the overwhelming
 * majority of it uninteresting `tool_result`. No official tool (CLI or MCP)
 * covered the need.
 *
 * This module only contains the PURE functions: extraction of the useful text of an
 * event, and construction of the FTS5 query. Indexing and reading live
 * in `db.ts` (`mission_search` table + `mission_search_fts` index). Deliberate
 * separation: they are testable without opening a database.
 *
 * What is indexed, and why this subset:
 *   - the mission's initial prompt (`missions.mission`);
 *   - the `text` blocks of the `assistant` events (what the agent ANSWERED);
 *   - the `text` blocks of the `user` events (what the human WROTE).
 * Left out: `thinking` (noise + base64 signature), `tool_use` (the commands
 * are already searchable in the code), and above all `tool_result` — on its own 1 GB
 * of the 1.3 GB of events, for content that is never what one looks for when
 * looking for "a conversation". Measured on the real database: 19 MB of useful text
 * out of 1.3 GB raw, that is an index 70× smaller than naively indexing everything.
 */

/** Role carried by an indexed fragment. `prompt` = the mission's initial statement. */
export type SearchRole = 'prompt' | 'assistant' | 'user';

export type SearchFragment = { role: SearchRole; text: string };

/** Max length of an indexed fragment. Beyond it, truncate: a 200 kB
 *  text block is a pasted dump, not a conversation, and it would blow up the index
 *  for zero recall gain. */
const MAX_FRAGMENT = 20_000;

function pushText(out: SearchFragment[], role: SearchRole, raw: unknown): void {
  if (typeof raw !== 'string') return;
  const text = raw.trim();
  if (!text) return;
  out.push({ role, text: text.length > MAX_FRAGMENT ? text.slice(0, MAX_FRAGMENT) : text });
}

/**
 * Extracts the indexable fragments of a mission event.
 *
 * `payload` is the already parsed JSON (or anything: the function never
 * throws, a malformed payload simply returns an empty list — indexing is
 * a side effect of `insertEvent`, it must never bring down the write
 * of the event itself).
 */
export function extractSearchFragments(type: string, payload: unknown): SearchFragment[] {
  // A spoken GPT-Live turn is conversation too; its speaker maps onto the
  // two roles a search already knows.
  if (type === 'voice_transcript') {
    const voice = payload as { role?: unknown; text?: unknown } | null;
    const out: SearchFragment[] = [];
    pushText(out, voice?.role === 'user' ? 'user' : 'assistant', voice?.text);
    return out;
  }
  if (type !== 'assistant' && type !== 'user') return [];
  const out: SearchFragment[] = [];
  const role: SearchRole = type === 'assistant' ? 'assistant' : 'user';
  const message = (payload as { message?: unknown } | null)?.message as
    | { content?: unknown }
    | undefined;
  const content = message?.content;
  if (typeof content === 'string') {
    pushText(out, role, content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== 'text') continue; // thinking / tool_use / tool_result : hors index
    pushText(out, role, b.text);
  }
  return out;
}

/**
 * Translates a human query into an FTS5 query.
 *
 * Semantics deliberately different from `toFtsQuery` (db.ts, memory recall),
 * which ORs everything to maximise recall: here a human searches
 * explicitly, they expect an AND. "fallback quota" must return the missions that
 * talk about BOTH, not the 300 that contain "quota".
 *
 * Supported: quotes delimit an exact phrase (`"rate limit"`), a
 * term suffixed with `*` stays a prefix (`worktree*`). Any other punctuation
 * is neutralised — an unescaped `:` or `-` makes the FTS5 parser fail
 * with a SqliteError the user has no way of interpreting.
 *
 * Returns `null` if the query contains no usable term.
 */
export function toMissionFtsQuery(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  const terms: string[] = [];
  // 1. quoted phrases, removed from the rest
  const rest = raw.replace(/"([^"]+)"/g, (_m, phrase: string) => {
    const words = sanitizeWords(phrase);
    if (words.length) terms.push(`"${words.join(' ')}"`);
    return ' ';
  });
  // 2. single words, with the `*` prefix kept
  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    const prefix = token.endsWith('*');
    const words = sanitizeWords(token);
    if (!words.length) continue;
    const term = words.length > 1 ? `"${words.join(' ')}"` : `"${words[0]}"`;
    terms.push(prefix ? `${term} *` : term);
  }
  if (!terms.length) return null;
  return terms.slice(0, 16).join(' AND ');
}

/** Reduces a text to its words (unicode letters/digits). Everything else becomes
 *  a separator: it is exactly the split of the default FTS5 tokenizer,
 *  so the query produced cannot contain a token that would not exist
 *  in the index. */
function sanitizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Interprets a time bound of the search: Unix ms, ISO date
 * (`2026-08-01`, `2026-08-01T14:00`), or relative duration (`7d`, `12h`, `30m`)
 * understood as "… ago".
 *
 * Returns `null` if the input is empty or unintelligible — the caller treats that
 * as "no bound" rather than as an error: a misunderstood bound
 * that silently filtered everything would be worse than no bound at all.
 */
export function parseTimeBound(input: string | undefined | null, now = Date.now()): number | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const rel = /^(\d+)\s*([mhdw])$/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? 'd').toLowerCase();
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
    return now - n * ms;
  }
  if (/^\d{10,}$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
