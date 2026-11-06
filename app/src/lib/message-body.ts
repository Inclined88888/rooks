/**
 * Split an inbox message payload into "what a human reads" and "what the
 * machine attached".
 *
 * Every writer of `agent_messages` funnels through `enqueueMessage`, so the
 * payload shapes are known (see `orchestrator/src/message-origin.ts`):
 * - daemon notifications (`wake_recap`, `system_alert`) carry the prose in
 *   `body`; task returns carry it in `done_comment`, a mission return (no
 *   task) in `final_text` (or `blocked_reason` when nothing was done);
 * - agents talking to each other send either free text, or a JSON object
 *   with `text` / `message` / `content` — the MCP tool only says "text or
 *   serialized JSON", so we accept the common spellings;
 * - the "TO DO" notebook push is plain text.
 *
 * Pure and DOM-free on purpose: the UI decides how to render each half, and
 * this module is unit-tested with the app's node runner.
 */

export type JsonObject = Record<string, unknown>;

export type ParsedMessageBody = {
  /** Prose to render as the mail body, or null when nothing reads as text. */
  text: string | null;
  /** Key of `text` inside the JSON object (null for free-text payloads). */
  textKey: string | null;
  /** The remaining top-level fields, in payload order (empty for free text). */
  fields: Array<[string, unknown]>;
  /** The parsed JSON object, or null for free text / invalid JSON. */
  json: JsonObject | null;
  /** Pretty-printed JSON when parseable, the raw payload otherwise. */
  raw: string;
};

/** Ordered by likelihood of holding the real content. */
const TEXT_KEYS = ['body', 'text', 'message', 'content', 'done_comment', 'final_text', 'blocked_reason'] as const;

/** `null`/`undefined` and empty strings are noise, not information. */
export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseObject(payload: string): JsonObject | null {
  const trimmed = payload.trim();
  // Arrays and scalars are valid JSON but have no fields to tabulate: they
  // read better as raw text than as an empty table.
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseMessageBody(payload: string): ParsedMessageBody {
  const json = parseObject(payload);
  if (!json) {
    return { text: payload, textKey: null, fields: [], json: null, raw: payload };
  }
  let textKey: string | null = null;
  for (const k of TEXT_KEYS) {
    const v = json[k];
    if (typeof v === 'string' && v.trim() !== '') { textKey = k; break; }
  }
  const fields = Object.entries(json).filter(([k]) => k !== textKey);
  return {
    text: textKey ? (json[textKey] as string) : null,
    textKey,
    fields,
    json,
    raw: JSON.stringify(json, null, 2),
  };
}

/**
 * Whether the field table deserves to start collapsed: a handful of short
 * scalars is context, a wall of nested data is debugging material.
 */
export function isLongFieldSet(fields: Array<[string, unknown]>): boolean {
  if (fields.length > 6) return true;
  let chars = 0;
  for (const [, v] of fields) {
    if (isPlainObject(v) || Array.isArray(v)) return true;
    chars += String(v ?? '').length;
    if (chars > 400) return true;
  }
  return false;
}
