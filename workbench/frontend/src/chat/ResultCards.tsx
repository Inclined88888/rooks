/**
 * Result cards in a reply (a draft, an event, a task, a note, files, a routine, a watched job) and the Undo that
 * sits on them. Undo goes through the history API exactly like the History page: GET /api/history lists what
 * happened with whether it can be undone, POST /api/history/{id}/undo does it, and a 409 means the service wants a
 * yes first (the entry's own confirm sentence). The history is fetched once per chat and shared by every card.
 */
import { AlertTriangle, Columns2, Undo2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { openStage, surfaceOf, useStage } from "../shell/StageHost";
import { Badge, Button } from "../ui";
import { useToast } from "../util";
import type { Card, Watch } from "./events";
import { matchHistoryEntries, type HistoryEntry } from "./turns";
import { watchSource } from "./watch";

const UNDOABLE = new Set(["draft", "event", "task", "note", "file", "routine"]);

/* ---- one shared copy of the recent history, per chat ---- */
let entries: HistoryEntry[] = [];
let loadedFor: number | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() { for (const fn of listeners) fn(); }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => entries;

/** Load (or reload) the newest history entries for this chat. Called by the cards and after a turn is done. */
export function refreshHistory(cid: number | null): Promise<void> {
  if (!cid) return Promise.resolve();
  const p = api<{ entries: HistoryEntry[] }>("/history?limit=60")
    .then((page) => { entries = page.entries || []; loadedFor = cid; emit(); })
    .catch(() => undefined)
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

function useHistoryEntries(cid: number | null, wanted: boolean): HistoryEntry[] {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!cid || !wanted) return;
    if (loadedFor !== cid && !inflight) void refreshHistory(cid);
  }, [cid, wanted]);
  return list;
}

/* ---- the cards ---- */
function when(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** A due date as a person says it ("Tue 10 Nov"); anything that is not a plain date stays as it came. */
function plainDate(value?: string): string {
  if (!value) return "";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function Undo({ entry, cid }: { entry: HistoryEntry; cid: number | null }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState<string | null>(null);
  const undo = async (confirmed = false) => {
    setBusy(true);
    try {
      const r = await api<HistoryEntry>(`/history/${entry.id}/undo`, { body: { confirm: confirmed } });
      const note = r.undo?.note || "Undone";
      toast.ok(note);
      setUndone(note);
      setAsking(false);
      void refreshHistory(cid);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && entry.undo.confirm && !confirmed) setAsking(true);
      else toast.err(err);
    } finally { setBusy(false); }
  };
  if (undone || entry.status === "undone") {
    return <Badge tone="neutral" title={undone || entry.undo.note || undefined}><Undo2 size={11} aria-hidden="true" /> Undone</Badge>;
  }
  if (!entry.undo.available) return null;
  if (asking) {
    return (
      <div className="result-undo-ask" role="group" aria-label="Confirm undo">
        <AlertTriangle size={14} aria-hidden="true" />
        <span className="result-undo-q">Undo this? {entry.undo.confirm}</span>
        <Button size="sm" variant="primary" busy={busy} onClick={() => undo(true)}>Yes, undo</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>Keep it</Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} busy={busy} onClick={() => (entry.undo.confirm ? setAsking(true) : undo())}>Undo</Button>
  );
}

function CardFrame({ kicker, title, children, actions, undo }: { kicker: string; title?: string; children?: React.ReactNode; actions?: React.ReactNode; undo?: React.ReactNode }) {
  return (
    <div className="result-card">
      <div className="result-card-kicker">{kicker}</div>
      {title && <div className="result-card-title">{title}</div>}
      {children}
      {(actions || undo) && <div className="result-card-actions">{actions}{undo}</div>}
    </div>
  );
}

export function ResultCard({ card, cid, entry, live }: { card: Card; cid: number | null; entry: HistoryEntry | null; live: boolean }) {
  const undo = entry ? <Undo entry={entry} cid={cid} /> : null;
  const c = card;
  if (c.kind === "draft") return (
    <CardFrame kicker="Draft email" title={c.subject || undefined} undo={undo} actions={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/mail">Review in Mail</Link>}>
      {c.to && <div className="result-card-meta">To {c.to}</div>}
      {c.body && <p className="result-card-body">{c.body}</p>}
      {c.status && <div className="result-card-meta">{c.status}</div>}
    </CardFrame>
  );
  if (c.kind === "event") return (
    <CardFrame kicker="Calendar" title={c.title || "Event"} undo={undo} actions={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/calendar">Open calendar</Link>}>
      {(c.start || c.location) && <div className="result-card-meta">{[when(c.start), c.location].filter(Boolean).join(" · ")}</div>}
    </CardFrame>
  );
  if (c.kind === "task") return (
    <CardFrame kicker="Task" title={c.title || "Task"} undo={undo} actions={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/tasks">Open tasks</Link>}>
      {c.due && <div className="result-card-meta">Due {plainDate(c.due)}</div>}
    </CardFrame>
  );
  if (c.kind === "note") return (
    <CardFrame kicker={c.note_kind === "document" ? "Document" : "Note"} title={c.title || "Note"} undo={undo}
      actions={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to={c.id ? `/${c.note_kind === "document" ? "documents" : "notes"}/${c.id}` : "/notes"}>Open it</Link>} />
  );
  if (c.kind === "file") return (
    <CardFrame kicker="Files" undo={undo} actions={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/files">Open files</Link>}>
      <p className="result-card-body">{(c.files || []).join(", ")}</p>
    </CardFrame>
  );
  if (c.kind === "routine") return (
    <CardFrame kicker="Routine" title={c.name || "Routine"} undo={undo} actions={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/automations">Open automations</Link>}>
      {c.sentence && <p className="result-card-body">{c.sentence}</p>}
    </CardFrame>
  );
  if (c.kind === "watch" && c.job_id) return <WatchCard watch={{ surface: c.surface || "computer", job_id: c.job_id, goal: c.goal }} live={live} />;
  return null;
}

/** Every card of one reply. `live` marks a reply made in this session (a watched job may still be running). */
export function ResultCards({ cards, cid, live = false, at }: { cards: Card[]; cid: number | null; live?: boolean; at?: string }) {
  const wanted = !!cid && cards.some((c) => UNDOABLE.has(c.kind));
  const history = useHistoryEntries(cid, wanted);
  if (!cards.length) return null;
  const undoable = cards.map((c) => (UNDOABLE.has(c.kind) ? c : { ...c, kind: "" }));
  const entries = matchHistoryEntries(undoable, history, cid, at);
  return (
    <div className="result-cards">
      {cards.map((c, i) => <ResultCard key={i} card={c} cid={cid} live={live} entry={entries[i]} />)}
    </div>
  );
}

/**
 * A job on a browser, this computer or the Room: a small card that opens it on the Stage (the right pane), which is
 * where the live view lives (src/stage/surfaces.tsx, with the Room's honesty check). The card itself shows no
 * picture, so a reloaded chat never pretends a screen is still live; watch.ts names the surface and where its page is.
 */
export function WatchCard({ watch, live }: { watch: Watch; live: boolean }) {
  const source = watchSource(watch);
  const stage = useStage();
  const surface = surfaceOf(watch.surface);
  const onStage = !!stage && stage.surface === surface && (stage.jobId || "") === watch.job_id;
  const open = () => openStage({ surface, jobId: watch.job_id, goal: watch.goal || undefined });
  const where = source.kicker === "Computer" ? "your computer" : `the ${source.kicker.toLowerCase()}`;
  const line = source.status
    ? (live ? "Rooks is using the Room. The Stage shows it as it really is." : "Rooks used the Room here. The Stage shows it as it is now.")
    : (live ? `Rooks is working on ${where}. Watch it on the Stage.` : `A job on ${where}. Its page has every step it took.`);
  return (
    <div className="result-card watch-card">
      <div className="result-card-kicker">{source.kicker}</div>
      {watch.goal && <div className="result-card-title">{watch.goal}</div>}
      <div className="result-card-meta">{line}</div>
      <div className="result-card-actions">
        <Button size="sm" variant={onStage ? "secondary" : "primary"} icon={<Columns2 size={13} />} aria-pressed={onStage} onClick={open}>
          {onStage ? "On the Stage" : "Open on the Stage"}
        </Button>
        <Link className="ui-btn ui-btn-ghost ui-btn-sm" to={source.open}>{source.status ? "Open the Room" : "Open the job"}</Link>
      </div>
    </div>
  );
}
