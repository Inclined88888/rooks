/**
 * Jobs (docs/design/0003-workroom.md, section 3): several jobs at once in Running / Needs you / Done columns, built on
 * the primitives. Every control and route is the same as before (the board, start, pause, resume, stop, retry, the
 * approvals, clear finished, notifications). The Needs you column is also the way into the inbox sheet: the presence
 * pill links to /jobs#needs-you, and that element opens the same sheet.
 */
import { Bell, Check, CircleStop, Inbox, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";
import { argsLine, stepTitle } from "../chat/turns";
import { openNeedsYou } from "../needs/store";
import { usePresence } from "../shell/presence";
import { ApprovalCard, Badge, Button, Card, Chip, EmptyState, ErrorState, IconButton, Loading, Page, Textarea, type Tone } from "../ui";
import { useCached } from "../lib/cache";
import { relTime, useToast } from "../util";
import { LiveMarkdown } from "./LiveBlocks";
import { jobControls, jobLabel } from "./live";
import "./v02.css";
import { plainError } from "../pages/day/parts";

export const JOBS_BUSY_MS = 3000;
export const JOBS_QUIET_MS = 15000;

export type Approval = { id: number; tool: string; args: string; reason: string; status: string; effect?: string };
export type Job = {
  id: number; kind: string; title: string; prompt: string; status: string; needs: string; detail: string; result: string;
  conversation_id: number | null; automation_id: number | null; column: "running" | "you" | "done"; approvals: Approval[];
  created_at: string; updated_at: string; finished_at: string | null;
};
export type Board = { running: Job[]; you: Job[]; done: Job[]; max_parallel: number; pro: boolean; tier: string };

const KINDS = [
  { v: "chat", label: "Assistant task" },
  { v: "browser", label: "On a website" },
  { v: "computer", label: "On this computer" },
  { v: "files", label: "With my files" },
];
const KIND_NAME: Record<string, string> = { chat: "Task", browser: "Website", computer: "Computer", files: "Files", playbook: "Show me how", automation: "Automation" };
const VERB: Record<string, { label: string; icon: typeof Play }> = {
  pause: { label: "Pause", icon: Pause }, resume: { label: "Resume", icon: Play }, stop: { label: "Stop", icon: CircleStop },
  start: { label: "Yes, run it", icon: Check }, deny: { label: "No", icon: X }, retry: { label: "Run again", icon: RotateCcw },
};
const TONE: Record<string, Tone> = { running: "live", waiting: "accent", done: "ok", failed: "danger" };

export default function JobsPage() {
  // The last board shows at once on a return visit and is asked again in the background (lib/cache.ts).
  const cached = useCached<Board>("jobs:board", () => api<Board>("/jobs"));
  const board = cached.data ?? null;
  const [problem, setProblem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState("chat");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
  const toast = useToast();
  const presence = usePresence();
  const location = useLocation();

  const load = () => cached.refresh();
  useEffect(() => { setProblem(cached.error ? plainError(cached.error, "The board did not load.") : ""); }, [cached.error]);
  // Every 3 s while a job runs or waits to start, every 15 s while the board is quiet, never while the tab is hidden;
  // at once when the shell's pulse says a job started, finished or needs you.
  const active = (board?.running.length ?? 0) > 0 || presence.running.jobs > 0;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void load(); }, active ? JOBS_BUSY_MS : JOBS_QUIET_MS);
    return () => clearInterval(t);
  }, [active]);
  const pulseKey = `${presence.running.jobs}:${presence.needs_you}`;
  const seenKey = useRef(pulseKey);
  useEffect(() => { if (seenKey.current !== pulseKey) { seenKey.current = pulseKey; void load(); } }, [pulseKey]);
  // the presence pill and the bottom bar link here as /jobs#needs-you: that lands in the inbox sheet
  useEffect(() => { if (location.hash === "#needs-you") openNeedsYou(); }, [location.hash]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try { await api("/jobs", { body: { kind, prompt } }); setPrompt(""); toast.ok("Added to the board"); void load(); }
    catch (err) { toast.err(err); }
  };
  const act = async (j: Job, verb: string) => {
    setBusy(`${j.id}:${verb}`);
    try { await api(`/jobs/${j.id}/${verb}`, { method: "POST" }); void load(); } catch (e) { toast.err(e); } finally { setBusy(""); }
  };
  const decide = async (a: Approval, approve: boolean) => {
    setBusy(`a${a.id}`);
    try { await api(`/approvals/${a.id}`, { body: { approve } }); toast.ok(approve ? "Done. The job carries on." : "Skipped. The job carries on without it."); void load(); }
    catch (e) { toast.err(e); } finally { setBusy(""); }
  };
  const clear = async () => { try { await api("/jobs/done", { method: "DELETE" }); void load(); } catch (e) { toast.err(e); } };
  const askPerm = async () => { if (typeof Notification !== "undefined") setPerm(await Notification.requestPermission()); };

  const card = (j: Job) => (
    <Card key={j.id} as="article" padding="sm" className={`job-card job-${j.status}`}>
      <div className="job-top">
        <span className="job-kind">{KIND_NAME[j.kind] ?? j.kind}</span>
        <Badge tone={TONE[j.status] ?? "neutral"}>{jobLabel(j.status, j.needs)}</Badge>
        <span className="job-grow" />
        <span className="job-when">{relTime(j.updated_at)}</span>
      </div>
      <button type="button" className="job-title" onClick={() => setOpen(open === j.id ? null : j.id)} aria-expanded={open === j.id}>{j.title}</button>
      {j.detail && <div className="job-detail">{j.detail}</div>}
      {j.approvals.map((a) => (
        <ApprovalCard key={a.id} className="job-approval-card" title={stepTitle(a.tool, a.args)} detail={a.reason || undefined} effect={a.effect || ""}
          command={argsLine(a.args) || undefined} busy={busy === `a${a.id}`}
          onApprove={() => void decide(a, true)} onDeny={() => void decide(a, false)} />
      ))}
      <div className="job-actions">
        {jobControls(j.status, j.needs).map((v) => {
          const V = VERB[v];
          return <Button key={v} size="sm" variant={v === "start" ? "primary" : "ghost"} icon={<V.icon size={13} />} busy={busy === `${j.id}:${v}`} onClick={() => void act(j, v)}>{V.label}</Button>;
        })}
        {j.conversation_id && <Link className="ui-btn ui-btn-ghost ui-btn-sm" to={`/assistant/${j.conversation_id}`}>Open chat</Link>}
      </div>
      {open === j.id && (
        <div className="job-more">
          <div className="job-more-k">What it was asked</div>
          <div className="job-prompt">{j.prompt.length > 600 ? j.prompt.slice(0, 600) + "…" : j.prompt}</div>
          {j.result && <><div className="job-more-k">Result</div><LiveMarkdown text={j.result} messageId={`job${j.id}`} /></>}
        </div>
      )}
    </Card>
  );

  const cols: { key: keyof Pick<Board, "running" | "you" | "done">; title: string; hint: string; empty: string }[] = [
    { key: "running", title: "Running", hint: "Working or in line", empty: "Nothing running" },
    { key: "you", title: "Needs you", hint: "Waiting for your OK", empty: "Nothing needs you" },
    { key: "done", title: "Done", hint: "Finished, stopped or failed", empty: "Nothing finished yet" },
  ];

  return (
    <Page title="Jobs" wide className="day-page"
      description="Hand off longer work and keep going. Jobs run in the background and ask you before anything is sent, posted, paid, deleted or changed outside the app."
      actions={(
        <>
          <Button icon={<Inbox size={15} />} onClick={() => openNeedsYou()} aria-haspopup="dialog">
            Needs you{presence.needs_you > 0 && <Badge tone="accent" className="day-needs-count">{presence.needs_you}</Badge>}
          </Button>
          {perm !== "granted" && typeof Notification !== "undefined" && <Button icon={<Bell size={15} />} onClick={() => void askPerm()}>Notify me</Button>}
        </>
      )}>
      <Card as="section" className="job-new" aria-label="New job">
        <form className="job-new-form" onSubmit={add}>
          <Textarea className="job-new-text" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should I work on? e.g. Compare the three quotes in my Files and draft a reply to the cheapest" aria-label="New job" />
          <div className="job-new-row">
            <div className="job-kinds" role="group" aria-label="Where it works">
              {KINDS.map((k) => <Chip key={k.v} active={kind === k.v} onClick={() => setKind(k.v)}>{k.label}</Chip>)}
            </div>
            <Button type="submit" variant="primary" icon={<Play size={14} />} disabled={!prompt.trim()}>Start job</Button>
          </div>
          {board && (
            <p className="job-new-note">
              {board.pro ? `Runs up to ${board.max_parallel} jobs at once.` : "The Free plan runs one job at a time. Pro runs several at once."} Computer jobs take turns, because there is one mouse and keyboard.
            </p>
          )}
        </form>
      </Card>

      {problem && <ErrorState title="The board did not load" line={problem} onRetry={() => void load()} />}
      {!board && !problem && <Loading rows={4} label="Loading the board" />}
      {board && (
        <div className="job-board">
          {cols.map((c) => (
            <section key={c.key} className={`job-col col-${c.key}`} aria-label={c.title}>
              <header className="job-col-head">
                <h2>{c.title}</h2><span className="job-count">{board[c.key].length}</span>
                <span className="job-grow" />
                {c.key === "you" && <Button id="needs-you" size="sm" variant="ghost" icon={<Inbox size={13} />} onClick={() => openNeedsYou()} aria-haspopup="dialog">Open the inbox</Button>}
                {c.key === "done" && board.done.length > 0 && <IconButton label="Clear finished jobs" size="sm" onClick={() => void clear()}><Trash2 size={13} /></IconButton>}
              </header>
              <p className="job-col-hint">{c.hint}</p>
              {board[c.key].length === 0
                ? <EmptyState className="job-empty" title={c.empty} />
                : board[c.key].map(card)}
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
