/**
 * The chat's events, typed, and one reducer over them (docs/design/0003-workroom.md, section 8 and package F2).
 *
 * A turn is one POST to /api/assistant/chat answered as a stream of JSON events. The service sends these types
 * (backend/app/assistant.py run_turn, assistant_api.py chat): start, writing, router, thought, tool_call, tool_result,
 * card, watch, approval_required, approval_denied, claim_check, choices, message, automate_offer, stopped, error, done,
 * tool_delegation, and from the reliability work resumed and compacted. parseEvent() turns a raw line into one of
 * them (anything else is dropped), reduceTurn() folds it into the turn's record: the steps with their receipts, the
 * cards, the approvals, the streamed draft and the final reply. Pure, so tests can run it.
 */
import { plainStep } from "../plainStep";
import type { RouterInfo } from "../util";

export const EVENT_TYPES = [
  "start", "writing", "router", "thought", "tool_call", "tool_result", "card", "watch", "approval_required", "approval_denied",
  "claim_check", "choices", "message", "automate_offer", "stopped", "error", "done", "resumed", "compacted", "tool_delegation",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Receipt = { verified: boolean | null; evidence: string };
export type Card = {
  kind: string; id?: number; title?: string; to?: string; subject?: string; body?: string; status?: string; start?: string; due?: string;
  sentence?: string; routine_kind?: string; name?: string; surface?: string; job_id?: string; goal?: string; files?: string[]; note_kind?: string; location?: string;
};
export type Watch = { surface: string; job_id: string; goal?: string };
export type Approval = { id: number; tool: string; args: string; effect: string; reason: string };
export type Choices = { question: string; options: string[] };
export type Offer = { key: string; name: string; request: string; line: string };
export type Done = { conversationId: number; costCents: number; toolCalls: number; outcome: string };

export type ChatEvent =
  | { type: "start"; conversation_id: number }
  | { type: "writing"; text: string }
  | { type: "router"; info: RouterInfo }
  | { type: "thought"; content: string }
  | { type: "tool_call"; name: string; args: string; from_text: boolean }
  | { type: "tool_result"; name: string; ok: boolean; preview: string; receipt?: Receipt }
  | { type: "card"; card: Card }
  | { type: "watch"; watch: Watch }
  | { type: "approval_required"; approval: Approval }
  | { type: "approval_denied"; approval: Approval }
  | { type: "claim_check"; backed: boolean; retrying: boolean; claim: string }
  | { type: "choices"; question: string; options: string[] }
  | { type: "message"; content: string }
  | { type: "automate_offer"; offer: Offer }
  | { type: "stopped"; content: string }
  | { type: "error"; error: string; budget: boolean }
  | { type: "done"; done: Done }
  | { type: "resumed"; reason: string; at: string }
  | { type: "compacted"; dropped_rows: number; summary_words: number }
  | { type: "tool_delegation"; id: number; tool: string; args: string; effect: string };

/** A receipt mark as the Receipt primitive draws it (src/ui). */
export type ReceiptMark = "verified" | "partly" | "unverified" | "contradicted";
export type StepState = "running" | "ok" | "failed" | "held";
export type StepKind = "call" | "thought" | "check" | "delegation";
export type Step = {
  id: string; kind: StepKind; name: string; args: string; text: string; state: StepState;
  receipt?: { state: ReceiptMark; evidence?: string }; preview?: string;
};
export type Notice = { kind: "resumed" | "compacted"; text: string };

export type TurnState = {
  conversationId: number | null;
  via?: RouterInfo;
  steps: Step[];
  cards: Card[];
  watch: Watch | null;
  approvals: Approval[];
  choices: Choices | null;
  /** The answer as it streams in (writing events). */
  draft: string;
  /** The final answer (message event), or null until it arrives. */
  reply: string | null;
  /** How much of the reply was already on screen as the draft; the reveal starts after it. */
  revealFrom: number;
  offer: Offer | null;
  notices: Notice[];
  stopped: boolean;
  stoppedNote: string;
  error: string | null;
  done: Done | null;
  seq: number;
};

const str = (v: unknown, fallback = ""): string => (v === undefined || v === null ? fallback : typeof v === "string" ? v : String(v));
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const bool = (v: unknown): boolean => v === true || v === "true" || v === 1;

function card(raw: Record<string, unknown>): Card {
  const c: Card = { kind: str(raw.kind) };
  for (const k of ["title", "to", "subject", "body", "status", "start", "due", "sentence", "routine_kind", "name", "surface", "job_id", "goal", "note_kind", "location"] as const) {
    if (raw[k] !== undefined && raw[k] !== null) c[k] = str(raw[k]);
  }
  if (raw.id !== undefined && raw.id !== null) c.id = num(raw.id);
  if (Array.isArray(raw.files)) c.files = raw.files.map((f) => str(f));
  return c;
}

function approval(raw: Record<string, unknown>): Approval {
  return { id: num(raw.id), tool: str(raw.tool), args: str(raw.args), effect: str(raw.effect), reason: str(raw.reason) };
}

/** One raw `data:` line as a typed event, or null for anything the chat does not understand. */
export function parseEvent(raw: Record<string, unknown> | null | undefined): ChatEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw.type;
  switch (t) {
    case "start": return { type: t, conversation_id: num(raw.conversation_id) };
    case "writing": return { type: t, text: str(raw.text) };
    case "router": return { type: t, info: raw as unknown as RouterInfo };
    case "thought": return { type: t, content: str(raw.content) };
    case "tool_call": return { type: t, name: str(raw.name), args: str(raw.args), from_text: bool(raw.from_text) };
    case "tool_result": {
      const r = raw.receipt && typeof raw.receipt === "object" ? (raw.receipt as Record<string, unknown>) : null;
      const receipt: Receipt | undefined = r ? { verified: r.verified === true ? true : r.verified === false ? false : null, evidence: str(r.evidence) } : undefined;
      return { type: t, name: str(raw.name), ok: bool(raw.ok), preview: str(raw.preview), receipt };
    }
    case "card": return { type: t, card: card(raw) };
    case "watch": return { type: t, watch: { surface: str(raw.surface, "computer"), job_id: str(raw.job_id), goal: str(raw.goal) } };
    case "approval_required": return { type: t, approval: approval(raw) };
    case "approval_denied": return { type: t, approval: approval(raw) };
    case "claim_check": return { type: t, backed: bool(raw.backed), retrying: bool(raw.retrying), claim: str(raw.claim) };
    case "choices": {
      const options = Array.isArray(raw.options) ? raw.options.map((o) => str(o)).filter(Boolean) : [];
      return { type: t, question: str(raw.question), options };
    }
    case "message": return { type: t, content: str(raw.content) };
    case "automate_offer": return { type: t, offer: { key: str(raw.key), name: str(raw.name), request: str(raw.request), line: str(raw.line) } };
    case "stopped": return { type: t, content: str(raw.content) };
    case "error": return { type: t, error: str(raw.error), budget: bool(raw.budget) };
    case "done": return { type: t, done: { conversationId: num(raw.conversation_id), costCents: num(raw.cost_cents), toolCalls: num(raw.tool_calls), outcome: str(raw.outcome) } };
    case "resumed": return { type: t, reason: str(raw.reason), at: str(raw.at) };
    case "compacted": return { type: t, dropped_rows: num(raw.dropped_rows), summary_words: num(raw.summary_words) };
    case "tool_delegation": return { type: t, id: num(raw.id), tool: str(raw.tool), args: str(raw.args), effect: str(raw.effect) };
    default: return null;
  }
}

export function emptyTurn(conversationId: number | null): TurnState {
  return {
    conversationId, steps: [], cards: [], watch: null, approvals: [], choices: null, draft: "", reply: null, revealFrom: 0,
    offer: null, notices: [], stopped: false, stoppedNote: "", error: null, done: null, seq: 0,
  };
}

/** Where the final reply's reveal starts: after the draft when the reply continues it, from the top otherwise. */
export function revealStart(draft: string, content: string): number {
  if (!draft) return 0;
  return content.startsWith(draft) ? draft.length : 0;
}

/** A receipt mark from the service's {verified, evidence}: true is verified, false contradicted, null nothing to check. */
export function receiptMark(r: Receipt | undefined): Step["receipt"] | undefined {
  if (!r || r.verified === null) return undefined;
  return { state: r.verified ? "verified" : "contradicted", evidence: r.evidence || undefined };
}

/** A tool's answer that says it is waiting for the person's OK (assistant.py _hold_message). */
export const HELD_PREFIX = /^Not run( yet)?:/;

export function stepState(ok: boolean, preview: string): StepState {
  if (ok) return "ok";
  return HELD_PREFIX.test(preview) ? "held" : "failed";
}

export const RESUMED_LINE = "Picked up after a restart";
/**
 * The compaction notice. Only what is true: earlier messages were shortened (an old tool answer cut down counts), and
 * "summarised" only when there is a summary. The summary's size is not what those messages became, so it is not said.
 */
export function compactedLine(dropped: number, words: number): string {
  const rows = `${dropped} earlier message${dropped === 1 ? "" : "s"}`;
  return `Earlier parts of this chat were ${words > 0 ? "shortened and summarised" : "shortened"} to fit (${rows}).`;
}

function withStep(s: TurnState, step: Omit<Step, "id">): TurnState {
  const seq = s.seq + 1;
  return { ...s, seq, steps: [...s.steps, { ...step, id: `s${seq}` }] };
}

/** The newest step that is still waiting for this tool's result. */
function pendingIndex(steps: Step[], name: string): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i];
    if ((st.kind === "call" || st.kind === "delegation") && st.name === name && st.state === "running") return i;
  }
  return -1;
}

function patchStep(s: TurnState, i: number, patch: Partial<Step>): TurnState {
  if (i < 0) return s;
  const steps = s.steps.slice();
  steps[i] = { ...steps[i], ...patch };
  return { ...s, steps };
}

/** Fold one event into the turn. Side effects (toasts, navigation, notifications) are the caller's. */
export function reduceTurn(s: TurnState, ev: ChatEvent | null): TurnState {
  if (!ev) return s;
  switch (ev.type) {
    case "start": return { ...s, conversationId: ev.conversation_id };
    case "writing": return { ...s, draft: s.draft + ev.text };
    case "router": return { ...s, via: ev.info };
    case "thought": {
      const text = ev.content.trim();
      return text ? withStep(s, { kind: "thought", name: "", args: "", text, state: "ok" }) : s;
    }
    case "tool_call":
      return withStep(s, { kind: "call", name: ev.name, args: ev.args, text: plainStep(ev.name, ev.args), state: "running" });
    case "tool_delegation":
      return withStep(s, { kind: "delegation", name: ev.tool, args: ev.args, text: `Handing to the terminal: ${plainStep(ev.tool, ev.args)}`, state: "running" });
    case "tool_result": {
      let i = pendingIndex(s.steps, ev.name);
      let next = s;
      if (i < 0) { // a result for a call the chat never saw (the front door path reports both at once)
        next = withStep(s, { kind: "call", name: ev.name, args: "", text: plainStep(ev.name), state: "running" });
        i = next.steps.length - 1;
      }
      return patchStep(next, i, { state: stepState(ev.ok, ev.preview), receipt: receiptMark(ev.receipt), preview: ev.preview || undefined });
    }
    case "card": {
      const next = { ...s, cards: [...s.cards, ev.card] };
      if (ev.card.kind === "watch" && ev.card.job_id) next.watch = { surface: ev.card.surface || "computer", job_id: ev.card.job_id, goal: ev.card.goal || "" };
      return next;
    }
    case "watch": return { ...s, watch: ev.watch };
    case "approval_required": {
      const next = { ...s, approvals: [...s.approvals, ev.approval] };
      const i = lastCall(next.steps, ev.approval.tool);
      return patchStep(next, i, { state: "held" });
    }
    case "approval_denied": {
      const i = lastCall(s.steps, ev.approval.tool);
      const text = `Not done: ${plainStep(ev.approval.tool, ev.approval.args)}`;
      if (i < 0) return withStep(s, { kind: "call", name: ev.approval.tool, args: ev.approval.args, text, state: "failed", preview: ev.approval.reason });
      return patchStep(s, i, { state: "failed", text, preview: ev.approval.reason || s.steps[i].preview });
    }
    case "claim_check":
      return withStep(s, { kind: "check", name: "", args: "", state: "failed",
        text: ev.retrying ? "That claim needs a check. Asking again." : "That claim is still unchecked.", preview: ev.claim || undefined });
    case "choices": return { ...s, choices: ev.options.length >= 2 ? { question: ev.question, options: ev.options } : s.choices };
    case "message": return { ...s, reply: ev.content, revealFrom: revealStart(s.draft, ev.content) };
    case "automate_offer": return { ...s, offer: ev.offer };
    case "stopped": return { ...s, stopped: true, stoppedNote: ev.content };
    case "error": return { ...s, error: ev.error };
    case "done": return { ...s, done: ev.done };
    case "resumed": return { ...s, notices: [...s.notices, { kind: "resumed", text: RESUMED_LINE }] };
    case "compacted": return { ...s, notices: [...s.notices, { kind: "compacted", text: compactedLine(ev.dropped_rows, ev.summary_words) }] };
    default: return s;
  }
}

/** The newest call step for a tool, whatever its state (an approval follows its own tool_result). */
function lastCall(steps: Step[], name: string): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i];
    if ((st.kind === "call" || st.kind === "delegation") && st.name === name) return i;
  }
  return -1;
}

/** One line for the thinking line: the newest step that is still running, else the newest step. */
export function currentLine(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].state === "running") return steps[i].text;
  return steps.length ? steps[steps.length - 1].text : undefined;
}
