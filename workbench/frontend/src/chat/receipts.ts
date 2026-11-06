/**
 * Receipts, and the words, for a turn that was rebuilt from the conversation's rows. The rows carry neither the
 * receipts nor the arguments of a call; the run log does (GET /api/runs?conversation_id, GET /api/runs/{turn}). A
 * rebuilt timeline asks for them when it is opened, and they are only merged when the run log's tool calls match
 * the steps one for one, in order: a step never shows a receipt, or a sentence, that might belong to another call.
 */
import { api } from "../api";
import { plainStep } from "../plainStep";
import type { Step } from "./events";

type TurnAction = { id: number; ts: string; kind: string; conversation_id: number | null };
export type TraceCall = { id: number; kind: string; tool: string; outcome: string; verified: number | null; evidence: string; args?: string };
type TraceNode = TraceCall & { children?: TraceNode[] };

const turnsByConv = new Map<number, Promise<TurnAction[]>>();

/** The turns in a run log answer, oldest first: the service sends a bare list (a page with a `runs` field is read too). */
export function turnsFrom(payload: unknown): TurnAction[] {
  const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as { runs?: unknown }).runs) ? (payload as { runs: unknown[] }).runs : [];
  return (rows as TurnAction[]).filter((a) => a && a.kind === "turn").sort((a, b) => Number(a.id) - Number(b.id));
}

function turnsOf(cid: number): Promise<TurnAction[]> {
  let p = turnsByConv.get(cid);
  if (!p) {
    p = api<unknown>(`/runs?conversation_id=${cid}&limit=200`).then(turnsFrom);
    turnsByConv.set(cid, p);
    p.catch(() => turnsByConv.delete(cid));
  }
  return p;
}

/** Forget the cached run list (a new turn finished, so the list grew). */
export function forgetRuns(cid: number) {
  turnsByConv.delete(cid);
}

/** The tool calls nested under a decision (a yes given later re-runs the held call there), oldest first. */
function reruns(node: TraceNode, out: TraceNode[] = []): TraceNode[] {
  for (const c of node.children || []) {
    if (c.kind === "tool_call") out.push(c);
    else reruns(c, out);
  }
  return out;
}

/**
 * The turn's own tool calls, oldest first. A held call carries the person's decision as a child, and a yes re-runs
 * the call under that decision: that re-run is the same step answered, so its outcome and check are folded into the
 * held call instead of being counted as another.
 */
export function traceCalls(node: TraceNode, out: TraceCall[] = []): TraceCall[] {
  for (const c of node.children || []) {
    if (c.kind !== "tool_call") { traceCalls(c, out); continue; }
    const call: TraceCall = { id: c.id, kind: c.kind, tool: c.tool, outcome: c.outcome, verified: c.verified, evidence: c.evidence, args: c.args };
    const again = (c.children || []).filter((d) => d.kind === "decision").flatMap((d) => reruns(d));
    const last = again[again.length - 1];
    if (last && last.tool === c.tool) Object.assign(call, { outcome: last.outcome, verified: last.verified, evidence: last.evidence, args: last.args || c.args });
    out.push(call);
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * The steps with what the run log knows: a receipt where a call was checked, and the call's arguments (so a step
 * rebuilt as "Using the Room" reads "Starting the Room: ..." like it did live) where the step has none of its own.
 * Null when the run log's calls do not match the steps one for one; the states stay the rows' own.
 */
export function applyTrace(steps: Step[], found: TraceCall[]): Step[] | null {
  const calls = steps.filter((s) => s.kind === "call");
  if (found.length !== calls.length || found.some((f, i) => f.tool !== calls[i].name)) return null;
  let k = 0;
  return steps.map((s) => {
    if (s.kind !== "call") return s;
    const f = found[k++];
    let next = s;
    const args = (f.args || "").trim();
    if (!s.args && args && args !== "{}") {
      const said = plainStep(s.name, args);
      next = { ...next, args, text: s.text.startsWith("Not done:") ? `Not done: ${said}` : said };
    }
    if (f.verified === 1) next = { ...next, receipt: { state: "verified", evidence: f.evidence || undefined } };
    else if (f.verified === 0) next = { ...next, receipt: { state: "contradicted", evidence: f.evidence || undefined } };
    return next;
  });
}

/**
 * The steps with their receipts from the run log, or null when no turn of the run log clearly matches (then the
 * steps stay as they are). `askedAt` and `repliedAt` bound the turn in time: the turn's record is written just
 * before the person's message is stored and well before the reply is.
 */
export async function receiptsFor(cid: number, askedAt: string | undefined, repliedAt: string | undefined, steps: Step[]): Promise<Step[] | null> {
  const calls = steps.filter((s) => s.kind === "call");
  const until = ms(repliedAt);
  if (!calls.length || Number.isNaN(until)) return null;
  const turns = await turnsOf(cid);
  const after = ms(askedAt);
  const candidates = turns.filter((t) => {
    const at = ms(t.ts);
    if (Number.isNaN(at) || at > until) return false;
    return Number.isNaN(after) || at >= after - 5000;
  });
  if (!candidates.length) return null;
  const turn = candidates[candidates.length - 1];
  const tree = await api<TraceNode>(`/runs/${turn.id}`);
  return applyTrace(steps, traceCalls(tree));
}
