/**
 * Helpers for the thread as a living record (package F2). Pure: no React, no network.
 *  - rebuildTurns: every turn's step timeline from the rows GET /api/conversations/{id} returns, so a reload keeps them.
 *    A decision answered later ("[I approved request #29: send_email. Result: ...]") closes the held step it answers
 *    instead of starting a turn of its own.
 *  - plainPreview: a tool's stored answer in plain words (no ids, no timestamps, no raw JSON, no notes meant for the model).
 *  - mergeSteps: a live timeline keeps its words and receipts when the server's rows are loaded over it.
 *  - splitNotVerified: the "Not verified" line the service appends to a reply becomes a receipt, not markdown.
 *  - adoptServerIds: a fresh turn's temporary ids give way to the server's once the turn is done; React keys stay.
 *  - matchHistoryEntry: a result card finds the history entry that can undo it.
 *  - greeting and suggestionChips: the empty state of a new chat.
 */
import { plainStep } from "../plainStep";
import { AUTOMATION_EXAMPLES } from "../v02/examples";
import { HELD_PREFIX, revealStart, type Card, type Step } from "./events";

export { revealStart };

export type Row = {
  id: number; role: string; content: string; tool_calls: string[]; name: string; tool_call_id?: string; created_at?: string;
  [extra: string]: unknown;
};
export type Turn = { userId: number; replyId: number | null; steps: Step[] };

/** A tool's stored answer as a step state: errors and holds are the service's own words at the start of the text. */
export function stateFromStored(content: string): Step["state"] {
  const t = (content || "").trimStart();
  if (HELD_PREFIX.test(t)) return "held";
  if (/^Error\b/.test(t)) return "failed";
  return "ok";
}

/* ---------------------------------------------------------------- decisions answered later */
/** The row the service stores when a held request is answered (assistant.py decide()). */
const DECISION = /^\[I (approved|denied) request #(\d+): ([A-Za-z0-9_.:-]+)\.\s*([\s\S]*)\]\s*$/;

export type Decision = { approved: boolean; requestId: number; tool: string; result: string };

/** The decision a stored user row records, or null for an ordinary message. */
export function parseDecision(row: Pick<Row, "role" | "content">): Decision | null {
  if (row.role !== "user") return null;
  const m = (row.content || "").trim().match(DECISION);
  if (!m) return null;
  const approved = m[1] === "approved";
  const result = approved ? (m[4] || "").trim().replace(/^Result:\s*/, "") : "";
  return { approved, requestId: Number(m[2]), tool: m[3], result };
}

/** True for a row that is the person's yes or no to a held step: it closes that step and is never a bubble. */
export const isDecisionRow = (row: Pick<Row, "role" | "content">): boolean => parseDecision(row) !== null;

/** The held step a decision answers: the one that names its request, else the newest held call of that tool. */
function heldStepFor(turns: Turn[], d: Decision): { turn: Turn; index: number } | null {
  const mention = `request #${d.requestId}`;
  let fallback: { turn: Turn; index: number } | null = null;
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    for (let i = turn.steps.length - 1; i >= 0; i--) {
      const s = turn.steps[i];
      if (s.kind !== "call" || s.state !== "held" || s.name !== d.tool) continue;
      if ((s.preview || "").includes(mention)) return { turn, index: i };
      if (!fallback) fallback = { turn, index: i };
    }
  }
  return fallback;
}

/** The step as it reads once the decision is in: done with the result, or not done because the person said no. */
export function decidedStep(step: Step, d: Decision): Step {
  if (!d.approved) return { ...step, state: "failed", text: `Not done: ${plainStep(step.name, step.args)}`, preview: "You said no." };
  const result = d.result || "Done.";
  return { ...step, state: stateFromStored(result) === "failed" ? "failed" : "ok", preview: result };
}

/**
 * Group the conversation's rows into turns. A turn starts at a person's message (claim-check nudges and decisions
 * are the service's rows, not a new turn) and holds the assistant's working rows (a thought, the tool calls) and the
 * tool rows that answer them, in order; the first assistant row with an answer and no tool calls is the reply. A
 * decision closes the held step it answers. Rebuilt steps carry no receipt: the service does not store one in the
 * rows, and a step never claims a check it did not get.
 */
export function rebuildTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let seq = 0;
  const step = (s: Omit<Step, "id">): Step => ({ ...s, id: `r${++seq}` });
  for (const r of rows) {
    if (r.role === "user") {
      if (r.name === "claim_check") {
        if (cur) cur.steps.push(step({ kind: "check", name: "", args: "", state: "failed", text: "That claim needed a check. It was asked again." }));
        continue;
      }
      const d = parseDecision(r);
      if (d) {
        const held = heldStepFor(turns, d);
        if (held) held.turn.steps[held.index] = decidedStep(held.turn.steps[held.index], d);
        else if (cur) cur.steps.push(decidedStep(step({ kind: "call", name: d.tool, args: "", state: "held", text: plainStep(d.tool) }), d));
        continue;
      }
      cur = { userId: r.id, replyId: null, steps: [] };
      turns.push(cur);
      continue;
    }
    if (!cur) continue; // rows before the first person's message (an automation's own turn) have no owner here
    const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
    if (r.role === "assistant") {
      if (calls.length) {
        const thought = (r.content || "").trim();
        if (thought) cur.steps.push(step({ kind: "thought", name: "", args: "", state: "ok", text: thought }));
        for (const name of calls) cur.steps.push(step({ kind: "call", name, args: "", state: "running", text: plainStep(name) }));
      } else if ((r.content || "").trim() && cur.replyId === null) {
        cur.replyId = r.id;
      }
      continue;
    }
    if (r.role === "tool") {
      const name = r.name || "";
      let i = cur.steps.findIndex((s) => s.kind === "call" && s.name === name && s.state === "running");
      if (i < 0) {
        cur.steps.push(step({ kind: "call", name, args: "", state: "running", text: plainStep(name) }));
        i = cur.steps.length - 1;
      }
      cur.steps[i] = { ...cur.steps[i], state: stateFromStored(r.content), preview: (r.content || "").trim() || undefined };
    }
  }
  // a call that never got its answer (a stopped or interrupted turn) is not still running
  for (const t of turns) t.steps = t.steps.map((s) => (s.state === "running" ? { ...s, state: "failed", preview: s.preview || "No answer was recorded for this step." } : s));
  return turns;
}

/* ---------------------------------------------------------------- a stored answer in plain words */
const UNTRUSTED_NOTE = /^\[Untrusted content from [^\]]*\]\s*/;
/** Keys that are the service's bookkeeping, not something the person asked for. */
const HIDDEN_KEY = /^(id|rid|uuid|.*_id|.*_at|etag|rev|driver)$/;
/** Values the service reports in its own terms, said the way the Room page says them. */
const WORDS: Record<string, Record<string, string>> = {
  isolation: { none: "shares this computer", namespace: "a private space of its own", vm: "a computer of its own" },
};
const NAME_KEYS = ["title", "name", "subject", "label", "summary", "content", "text", "path", "file", "query"];

function tryJson(text: string): unknown {
  if (!/^[[{"\d-]/.test(text) && text !== "null" && text !== "true" && text !== "false") return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length);

function nameOf(item: unknown, i: number): string {
  if (item === null || item === undefined) return `item ${i + 1}`;
  if (typeof item !== "object") return String(item);
  const o = item as Record<string, unknown>;
  for (const k of NAME_KEYS) if (typeof o[k] === "string" && (o[k] as string).trim()) return (o[k] as string).trim();
  const first = Object.entries(o).find(([k, v]) => !HIDDEN_KEY.test(k) && typeof v === "string" && (v as string).trim());
  return first ? String(first[1]).trim() : `item ${i + 1}`;
}

function plainValue(v: unknown, depth: number): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    if (!v.length) return "";
    if (v.every((x) => x === null || typeof x !== "object")) return v.filter((x) => !isEmpty(x)).map((x) => plainValue(x, depth + 1)).join(", ");
    const names = v.slice(0, 8).map(nameOf);
    return `${v.length} item${v.length === 1 ? "" : "s"}: ${names.join(", ")}${v.length > 8 ? ", …" : ""}`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([k, x]) => !HIDDEN_KEY.test(k) && !isEmpty(x));
  const lines = entries.map(([k, x]) => {
    const said = typeof x === "string" ? WORDS[k]?.[x] : undefined;
    const inner = said ?? (typeof x === "object" && x !== null && !Array.isArray(x) && depth < 2 ? `(${plainValue(x, depth + 1)})` : plainValue(x, depth + 1));
    return `${k.replace(/_/g, " ")}: ${inner}`;
  }).filter((line) => !/:\s*(\(\))?$/.test(line));
  return lines.join(depth ? ", " : "\n");
}

/** A hold, in the person's words: the stored text is written for the model. */
function heldLine(text: string): string {
  return /^Not run yet:/.test(text) ? "Waiting for your OK." : "Not run. Nobody was there to say yes, so it was skipped.";
}

/**
 * A tool's stored answer as plain words for the step detail: JSON becomes "key: value" lines without ids or
 * timestamps, a list becomes "3 items: A, B, C", a hold becomes "Waiting for your OK.", the model's untrusted-content
 * note is dropped, and any other text (an error line, a sentence) stays as it is.
 */
export function plainPreview(raw: string | undefined, max = 600): string {
  let text = (raw || "").trim();
  if (!text) return "";
  text = text.replace(UNTRUSTED_NOTE, "").trim();
  if (/^Not run( yet)?:/.test(text)) return heldLine(text);
  const parsed = tryJson(text);
  if (parsed === undefined) return clipText(text, max);
  if (parsed === null) return "Nothing came back.";
  const said = plainValue(parsed, 0);
  return clipText(said || "Nothing came back.", max);
}

/* ---------------------------------------------------------------- live steps over rebuilt ones */
/**
 * The server's rebuilt timeline laid over the one this session drew live: the rebuilt steps bring the newer truth
 * (a decision that closed a held step, the full stored answer); the live steps keep their arguments, their words and
 * their receipts, which the rows do not carry. Steps are paired in order by kind and tool; anything only one side
 * has is kept in place.
 */
export function mergeSteps(live: Step[] | undefined, rebuilt: Step[] | undefined): Step[] | undefined {
  if (!live?.length) return rebuilt;
  if (!rebuilt?.length) return live;
  const out: Step[] = [];
  let j = 0;
  for (const r of rebuilt) {
    let k = -1;
    for (let i = j; i < live.length; i++) {
      const l = live[i];
      if (l.kind === r.kind && (r.kind !== "call" || l.name === r.name)) { k = i; break; }
    }
    if (k < 0) { out.push(r); continue; }
    for (let i = j; i < k; i++) out.push(live[i]);
    const l = live[k];
    j = k + 1;
    const args = l.args || r.args;
    const text = r.text.startsWith("Not done:") ? `Not done: ${plainStep(r.name, args)}` : (l.args ? l.text : r.text);
    out.push({ ...r, id: l.id, args, text, receipt: l.receipt ?? r.receipt, preview: r.preview ?? l.preview });
  }
  for (let i = j; i < live.length; i++) out.push(live[i]);
  return out;
}

/* ---------------------------------------------------------------- the reply's receipt */
const NOT_VERIFIED = /\n\n\*\*Not verified:\*\*\s*([\s\S]*?)\s*$/;

/** The service appends "**Not verified:** I said ..., but ... Check this before relying on it." to a reply it could not back. */
export function splitNotVerified(content: string): { body: string; unverified: string | undefined } {
  const m = content.match(NOT_VERIFIED);
  if (!m) return { body: content, unverified: undefined };
  return { body: content.slice(0, m.index).replace(/\s+$/, ""), unverified: m[1].replace(/\*\*/g, "").trim() };
}

/* ---------------------------------------------------------------- ids */
export type Keyed = { id: number; key: string; role: string; content: string; [extra: string]: unknown };

/** True for an id the chat made up while the turn ran (Date.now()), before the service named the row. */
export const isTempId = (id: number) => id > 1e12;

/**
 * After a turn is done, give the fresh messages the ids the server stored them under, matching by role and text in
 * order, newest first. Keys are untouched so nothing on screen re-mounts; everything else on the message stays.
 */
export function adoptServerIds<T extends Keyed>(local: T[], server: { id: number; role: string; content: string }[]): T[] {
  const known = new Set(server.map((r) => r.id));
  const used = new Set<number>(local.filter((m) => !isTempId(m.id)).map((m) => m.id));
  const out = local.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!isTempId(m.id) || known.has(m.id)) continue;
    for (let j = server.length - 1; j >= 0; j--) {
      const r = server[j];
      if (used.has(r.id) || r.role !== m.role || (r.content || "").trim() !== (m.content || "").trim()) continue;
      used.add(r.id);
      out[i] = { ...m, id: r.id };
      break;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- undo */
export type HistoryEntry = {
  id: string; at: string; category: string; tool: string; title: string; conversation_id: number | null; status: string;
  undo: { available: boolean; confirm: string; reversible: boolean; note: string }; [extra: string]: unknown;
};

const TOOLS_OF_KIND: Record<string, string[]> = {
  draft: ["save_email_draft"], event: ["create_event", "site_schedule"], task: ["create_task"], note: ["create_note"],
  file: ["make_document", "edit_spreadsheet", "run_python", "use_computer"], routine: ["schedule_task", "watch_site"],
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** What of the card the history title must mention (history.py describe() clips titles at 80 characters). */
function cardWords(card: Card): string[] {
  const parts = [card.title, card.subject, card.to, card.name, ...(card.files || [])].filter((x): x is string => !!x && !!x.trim());
  return parts.map((p) => norm(p).slice(0, 56));
}

/** The newest history entry of this chat that recorded the change behind a result card, or null. */
export function matchHistoryEntry(card: Card, entries: HistoryEntry[], cid: number | null): HistoryEntry | null {
  const tools = TOOLS_OF_KIND[card.kind];
  if (!tools || !cid) return null;
  const words = cardWords(card);
  const ordered = entries.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const e of ordered) {
    if (e.conversation_id !== cid || !tools.includes(e.tool)) continue;
    const title = norm(e.title);
    if (!words.length || words.some((w) => w && title.includes(w))) return e;
  }
  return null;
}

/* ---------------------------------------------------------------- a new chat */
/** "Morning. What should we do first?", by the hour of the day. */
export function greeting(hour: number): string {
  const word = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  return `${word}. What should we do first?`;
}

export type Routine = { kind: string; id: number; name: string; sentence: string; enabled: boolean };
export type Suggestion = { text: string; send: string };

/** Three things to do: the person's own routines first, then automation examples. */
export function suggestionChips(routines: Routine[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const r of routines) {
    if (!r.enabled || !r.sentence || out.length >= 3) continue;
    const text = r.sentence.trim();
    out.push({ text: text[0].toUpperCase() + text.slice(1), send: `Do this now, once: ${text}` });
  }
  for (const ex of AUTOMATION_EXAMPLES) {
    if (out.length >= 3) break;
    out.push({ text: ex, send: `Set this up: ${ex}` });
  }
  return out.slice(0, 3);
}

/* ---------------------------------------------------------------- the approval card's words */
/** A tool call as a title for the approval card: the plain sentence, or the tool's name in words. */
export function stepTitle(tool: string, args = ""): string {
  const said = plainStep(tool, args);
  if (said !== "Working") return said;
  const words = tool.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "A step";
}

/** The arguments of a tool call as one readable line: "to: dave@example.com · subject: Hi". */
export function argsLine(raw: string, max = 220): string {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    if (!a || typeof a !== "object") return raw.slice(0, max);
    return Object.entries(a).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ").slice(0, max);
  } catch { return (raw || "").slice(0, max); }
}

/** The command a held tool wants to run, for the approval card's command box. */
export function commandOf(args: string): string {
  try { return String((JSON.parse(args) as { command?: unknown }).command ?? ""); } catch { return ""; }
}
