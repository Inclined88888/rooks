/**
 * The thread: the conversation as a living record (docs/design/0003-workroom.md, section 3). Every turn keeps its
 * step timeline (live from the events, rebuilt from the server after a reload, never wiped), each step shows its
 * receipt when the service sent one, result cards carry Undo, approvals are the one ApprovalCard, and the final
 * reply is revealed once: what already streamed in stays, only the rest is revealed.
 */
import { ChevronDown, ChevronRight, Pencil, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api";
import { MessageAttachments } from "../Attachments";
import { DiffView, extractDiffFromArgs } from "../components/DiffView";
import { Thinking } from "../motion";
import { ApprovalCard, Receipt, Timeline, type TimelineStep } from "../ui";
import { Markdown, RouterVia, useToast } from "../util";
import { CheckThis } from "../v02/ChatExtras";
import { LiveMarkdown } from "../v02/LiveBlocks";
import { currentLine, type Approval, type Choices, type Notice, type Step, type TurnState } from "./events";
import { receiptsFor } from "./receipts";
import { ResultCards } from "./ResultCards";
import { argsLine, commandOf, isDecisionRow, plainPreview, splitNotVerified, stepTitle } from "./turns";
import { madeHere, type Msg } from "./types";

export type Fresh = { key: string; from: number };

export type ThreadProps = {
  who: string;
  cid: number | null;
  messages: Msg[];
  /** The turn in flight, while it runs. */
  live: TurnState | null;
  busy: boolean;
  busySince: number;
  approvals: Approval[];
  leaving: (id: number) => boolean;
  onDecide: (a: Approval, approve: boolean) => void;
  /** The reply being revealed right now, and how much of it was already on screen as the draft. */
  fresh: Fresh | null;
  onRevealDone: () => void;
  onPickChoice: (option: string) => void;
  onRegenerate: () => void;
  editing: number | null;
  editText: string;
  onEditStart: (m: Msg) => void;
  onEditChange: (text: string) => void;
  onEditSave: (m: Msg) => void;
  onEditCancel: () => void;
  /** Which turns show their timeline open (the one that just finished does by default). */
  open: Record<string, boolean>;
  onToggleSteps: (key: string) => void;
  /** Shown when the thread has no messages yet. */
  empty: React.ReactNode;
  endRef: RefObject<HTMLDivElement>;
};

const srOnly: React.CSSProperties = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 };

/** What to show in the thread: people's messages (not the service's claim-check nudges, not a yes or no to a held
 *  step, which closes that step in its timeline instead), and replies that are answers (not the working rows). */
export function visibleMessages(messages: Msg[]): Msg[] {
  return messages.filter((m) => (m.role === "user" && m.name !== "claim_check" && !isDecisionRow(m)) || (m.role === "assistant" && !!m.content && !(m.tool_calls || []).length));
}

const toTimeline = (s: Step): TimelineStep => ({ id: s.id, text: s.text, state: s.state, receipt: s.receipt });

function stepsSummary(steps: Step[]): string {
  const n = steps.length;
  const failed = steps.filter((s) => s.state === "failed").length;
  const held = steps.filter((s) => s.state === "held").length;
  const base = `${n} step${n === 1 ? "" : "s"}`;
  if (held) return `${base}, ${held} waiting for your OK`;
  if (failed) return `${base}, ${failed} did not work`;
  return base;
}

function StepDetail({ step }: { step: Step }) {
  const diff = step.kind === "call" && (step.name === "edit_file" || step.name === "write_file") && step.args ? extractDiffFromArgs(step.args) : null;
  if (diff) return <div className="turn-step-detail"><DiffView diff={diff} compact /></div>;
  const args = step.args ? argsLine(step.args) : "";
  const answer = plainPreview(step.preview); // the stored answer in plain words: no ids, no timestamps, no raw JSON
  if (!args && !answer) return null;
  return (
    <div className="turn-step-detail">
      <div className="turn-step-which">{step.text}</div>
      {args && <div className="turn-step-args">{args}</div>}
      {answer && <pre className="turn-step-preview">{answer}</pre>}
    </div>
  );
}

/** One turn's timeline: collapsed with a count once the turn is over, drawing while it runs. */
function StepsPanel({ steps, open, onToggle, live, label }: { steps: Step[]; open: boolean; onToggle?: () => void; live?: boolean; label: string }) {
  const [pick, setPick] = useState<string | null>(null);
  if (!steps.length) return null;
  const picked = pick ? steps.find((s) => s.id === pick) : undefined;
  return (
    <div className={`turn-steps${open ? " is-open" : ""}${live ? " is-live" : ""}`}>
      {!live && onToggle && (
        <button type="button" className="turn-steps-toggle" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          <span>{stepsSummary(steps)}</span>
        </button>
      )}
      {open && <Timeline steps={steps.map(toTimeline)} label={label} current={pick ?? undefined} onPick={(id) => setPick((cur) => (cur === String(id) ? null : String(id)))} />}
      {open && picked && <StepDetail step={picked} />}
    </div>
  );
}

function Notices({ notices }: { notices?: Notice[] }) {
  if (!notices?.length) return null;
  return (
    <div className="turn-notices">
      {notices.map((n, i) => <p key={i} className={`turn-notice is-${n.kind}`} role="status">{n.text}</p>)}
    </div>
  );
}

function ChoiceButtons({ c, onPick }: { c: Choices; onPick: (s: string) => void }) {
  if (c.options.length < 2) return null;
  return (
    <div className="chat-choices" role="group" aria-label={c.question || "Quick replies"}>
      {c.options.map((o) => (
        <button key={o} type="button" className="btn sm" onClick={() => onPick(o)}>{o}</button>
      ))}
    </div>
  );
}

/** Thumbs and "Fix this" under each reply: both go to /api/learn/feedback, so the next answer follows the lesson. */
function MessageFeedback({ msg }: { msg: Msg }) {
  const [rating, setRating] = useState(0);
  const [mode, setMode] = useState<"" | "why" | "edit">("");
  const [comment, setComment] = useState("");
  const [edited, setEdited] = useState(msg.content);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const send = async (body: { rating?: number; comment?: string; edited?: string }) => {
    setBusy(true);
    try {
      const r = await api<{ note: string }>("/learn/feedback", {
        body: { target_kind: "message", target_id: String(msg.id), original: body.edited !== undefined ? msg.content : "", ...body },
      });
      setNote(r.note || "Thanks, noted.");
      setMode("");
    } catch (e) { toast.err(e); } finally { setBusy(false); }
  };
  const thumb = (r: number) => {
    setRating(r);
    if (r > 0) send({ rating: 1 }); else setMode("why");
  };
  return (
    <div className="msg-feedback">
      <div className="row" style={{ gap: 2 }}>
        <button className={`btn ghost sm icon${rating > 0 ? " on" : ""}`} aria-pressed={rating > 0} aria-label="Good answer" title="Good answer" disabled={busy} onClick={() => thumb(1)}><ThumbsUp size={13} /></button>
        <button className={`btn ghost sm icon${rating < 0 ? " on" : ""}`} aria-pressed={rating < 0} aria-label="Not right" title="Not right" disabled={busy} onClick={() => thumb(-1)}><ThumbsDown size={13} /></button>
        <button className="btn ghost sm icon" title="Fix this" aria-label="Fix this" disabled={busy} onClick={() => setMode(mode === "edit" ? "" : "edit")}><Pencil size={13} /></button>
        {note && <span className="muted small" role="status">{note}</span>}
      </div>
      {mode === "why" && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input className="input grow" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What should I do differently? (optional)" aria-label="What should I do differently?" />
          <button className="btn sm primary" disabled={busy} onClick={() => send({ rating: -1, comment })}>Send</button>
        </div>
      )}
      {mode === "edit" && (
        <div className="col" style={{ gap: 6, marginTop: 6 }}>
          <textarea className="input" rows={6} value={edited} onChange={(e) => setEdited(e.target.value)} aria-label="Your version" />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm primary" disabled={busy || edited.trim() === msg.content.trim()} onClick={() => send({ rating, edited })}>Save my version</button>
            <button className="btn sm ghost" onClick={() => setMode("")}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The verdict the service gave the whole turn, as a receipt at the end of the reply. */
function OutcomeReceipt({ outcome }: { outcome?: string }) {
  if (outcome === "backed") return <Receipt state="verified" evidence="Everything this reply says it did was checked against what changed." />;
  if (outcome === "fixed") return <Receipt state="verified" evidence="A claim was withdrawn and checked again before this reply was shown." />;
  return null;
}

function UserMessage({ m, p }: { m: Msg; p: ThreadProps }) {
  if (p.editing === m.id) {
    return (
      <div className="msg user">
        <div className="col" style={{ gap: 6, alignItems: "flex-end" }}>
          <textarea className="input" rows={3} value={p.editText} aria-label="Edit message" autoFocus
            onChange={(e) => p.onEditChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); p.onEditSave(m); } if (e.key === "Escape") p.onEditCancel(); }} />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm primary" disabled={p.busy || !p.editText.trim()} onClick={() => p.onEditSave(m)}>Send</button>
            <button className="btn sm ghost" onClick={p.onEditCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg user">
      <div className="msg-user-row">
        <div className="col" style={{ gap: 0, alignItems: "flex-end" }}>
          <MessageAttachments items={m.attachments} />
          {m.content && <div className="bubble-user">{m.content}</div>}
        </div>
        <button className="btn ghost sm icon msg-edit" aria-label="Edit and resend" title="Edit and resend" disabled={p.busy}
          onClick={() => p.onEditStart(m)}><Pencil size={12} /></button>
      </div>
    </div>
  );
}

/** A reply: the turn's notices and timeline, the answer, its receipts, cards, choices and actions. */
function ReplyMessage({ m, p, askedAt, isLast }: { m: Msg; p: ThreadProps; askedAt?: string; isLast: boolean }) {
  const [steps, setSteps] = useState<Step[]>(m.steps || []);
  useEffect(() => { setSteps(m.steps || []); }, [m.steps]);
  const open = !!p.open[m.key];
  const fromHere = madeHere(m);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // A timeline rebuilt from the rows has neither receipts nor the calls' words; ask the run log once per timeline,
  // when the person opens it. A ref remembers what was asked (state would re-run this effect and drop the answer),
  // and the answer only lands on the very steps it was asked about.
  const askedFor = useRef<Step[] | null>(null);
  useEffect(() => {
    if (!open || fromHere || !p.cid || !steps.length || steps.some((s) => s.receipt) || askedFor.current === steps) return;
    const asked = steps;
    askedFor.current = asked;
    receiptsFor(p.cid, askedAt, m.created_at, asked)
      .then((withReceipts) => { if (alive.current && withReceipts) setSteps((cur) => (cur === asked ? withReceipts : cur)); })
      .catch(() => undefined);
  }, [open, fromHere, p.cid, steps, askedAt, m.created_at]);
  const { body, unverified } = splitNotVerified(m.content);
  const revealing = p.fresh?.key === m.key;
  return (
    <div className="msg">
      <div className="msg-body">
        <div className="msg-byline" aria-hidden="true">{p.who}</div>
        <Notices notices={m.notices} />
        <StepsPanel steps={steps} open={open} onToggle={() => p.onToggleSteps(m.key)} label="What it did" />
        {body && (revealing
          ? <LiveMarkdown text={body} messageId={m.id} streaming from={p.fresh?.from ?? 0} onDone={p.onRevealDone} />
          : <LiveMarkdown text={body} messageId={m.id} />)}
        {(unverified || m.outcome) && (
          <div className="msg-receipts">
            {unverified && <Receipt state="unverified" evidence={unverified} />}
            {!unverified && <OutcomeReceipt outcome={m.outcome} />}
          </div>
        )}
        {m.via && <RouterVia r={m.via} />}
        {m.cards && <ResultCards cards={m.cards} cid={p.cid} live={fromHere} />}
        {m.choices && isLast && !p.busy && <ChoiceButtons c={m.choices} onPick={p.onPickChoice} />}
        {body && !revealing && (
          <div className="msg-actions">
            <MessageFeedback msg={m} />
            <CheckThis cid={p.cid} content={body} fresh={fromHere} />
            {isLast && !p.busy && (
              <button className="btn ghost sm icon" aria-label="Regenerate reply" title="Answer again" onClick={p.onRegenerate}><RotateCcw size={13} /></button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The turn in flight: the timeline drawing as steps arrive, the answer as it streams, the thinking line. */
function LiveTurn({ live, who, since }: { live: TurnState; who: string; since: number }) {
  return (
    <div className="msg msg-live msg-thinking" aria-label="Assistant is working">
      <div className="msg-body">
        <div className="msg-byline is-thinking" aria-hidden="true">{who}</div>
        <Notices notices={live.notices} />
        <StepsPanel steps={live.steps} open live label="What it is doing" />
        {live.draft && <div className="msg-text"><Markdown text={live.draft} /></div>}
        <Thinking since={since} line={currentLine(live.steps)} />
      </div>
    </div>
  );
}

export function Thread(p: ThreadProps) {
  const visible = visibleMessages(p.messages);
  const lastReply = [...visible].reverse().find((m) => m.role === "assistant" && m.content);
  const showLive = p.busy && p.live && p.live.reply === null;
  let askedAt: string | undefined;
  return (
    <div className="chat-scroll" aria-live="polite">
      {/* the shell owns the one main landmark; the thread is the skip link's target */}
      <section id="thread" className="chat-thread" aria-label="Chat conversation" tabIndex={-1}>
        <h1 style={srOnly}>Chat conversation</h1>
        {!p.busy && visible.length === 0 && p.empty}
        {visible.map((m) => {
          if (m.role === "user") {
            askedAt = m.created_at;
            return (
              <div key={m.key} className="turn-user">
                <UserMessage m={m} p={p} />
                {m.orphanSteps?.length ? (
                  <div className="msg"><div className="msg-body">
                    <div className="msg-byline" aria-hidden="true">{p.who}</div>
                    <StepsPanel steps={m.orphanSteps} open={!!p.open[m.key]} onToggle={() => p.onToggleSteps(m.key)} label="What it did" />
                  </div></div>
                ) : null}
              </div>
            );
          }
          return <ReplyMessage key={m.key} m={m} p={p} askedAt={askedAt} isLast={lastReply?.key === m.key} />;
        })}
        {p.approvals.map((a) => {
          const diff = (a.tool === "edit_file" || a.tool === "write_file") ? extractDiffFromArgs(a.args) : null;
          const command = a.effect === "command" && !diff ? commandOf(a.args) : "";
          return (
            <ApprovalCard key={a.id} className={p.leaving(a.id) ? "leaving-out" : undefined}
              title={stepTitle(a.tool, a.args)} detail={a.reason || undefined} effect={a.effect}
              command={command || (!diff ? argsLine(a.args) || undefined : undefined)}
              diff={diff ? <DiffView diff={diff} compact /> : undefined}
              onApprove={() => p.onDecide(a, true)} onDeny={() => p.onDecide(a, false)} />
          );
        })}
        {showLive && p.live && <LiveTurn live={p.live} who={p.who} since={p.busySince} />}
        <div ref={p.endRef} />
      </section>
    </div>
  );
}
