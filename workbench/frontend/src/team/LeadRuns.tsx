// B1: the AI team lead's sub-agent runs as a tree: the goal, each read-only sub-task with its job, and the synthesis.
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { relTime } from "../util";
import { Badge, EmptyState, ErrorState, Loading } from "../ui";
import { plainError } from "../pages/agents/kit";

export type SubTask = { id: string; task: string; job_id: number; status: string; conversation_id: number | null; result: string | null };
export type LeadRun = {
  id: number; goal: string; status: string; conversation_id: number | null; subtasks: SubTask[];
  synthesis: string | null; created_at: string; finished_at: string | null;
};

const LIVE = new Set(["running", "queued", "synthesizing"]);
const LABEL: Record<string, string> = {
  running: "Running", queued: "Waiting", synthesizing: "Writing it up", done: "Done", failed: "Failed", stopped: "Stopped",
};

export function statusLabel(s: string) { return LABEL[s] ?? s; }

export default function LeadRuns() {
  const [runs, setRuns] = useState<LeadRun[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const load = useCallback(() => api<LeadRun[]>("/team/lead?limit=20").then((r) => { setRuns(r); setErr(null); }).catch((e) => setErr(e ?? new Error("failed"))), []);
  const live = !!runs?.some((r) => LIVE.has(r.status) || r.subtasks.some((s) => LIVE.has(s.status)));
  useEffect(() => { load(); }, [load]);
  useEffect(() => {  // poll only while something is still running and the page is visible
    if (!live) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 4000);
    return () => clearInterval(t);
  }, [live, load]);

  if (err && !runs) return <ErrorState title="The AI runs did not load" line={plainError(err)} onRetry={load} />;
  if (!runs) return <Loading rows={3} />;
  if (!runs.length) return <EmptyState icon={<Sparkles size={20} />} title="No AI team runs yet" line="Ask in chat for something with several parts, like comparing three suppliers; each run shows here." />;
  return (
    <section className="col gap" aria-label="AI team runs" aria-live="polite">
      {runs.map((r, i) => {
        const done = r.subtasks.filter((s) => !LIVE.has(s.status)).length;
        const isOpen = open[r.id] ?? (i === 0 || LIVE.has(r.status));  // the newest and any live run start open
        return (
          <article key={r.id} className="card col gap lead-run" data-status={r.status}>
            <button className="row lead-run-head" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [r.id]: !isOpen })}>
              {isOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
              <strong className="grow lead-goal">{r.goal}</strong>
              <Badge tone={LIVE.has(r.status) ? "live" : r.status === "failed" ? "danger" : r.status === "done" ? "ok" : "neutral"}>{statusLabel(r.status)}</Badge>
              <span className="muted small">{done}/{r.subtasks.length} sub-tasks · {relTime(r.created_at)}</span>
            </button>
            {isOpen && <>
              <ol className="lead-tree" aria-label={`Sub-tasks of run ${r.id}`}>
                {r.subtasks.map((s) => (
                  <li key={s.id} className="lead-sub" data-status={s.status}>
                    <div className="row gap">
                      <span className="grow">{s.task}</span>
                      <Badge tone={LIVE.has(s.status) ? "live" : s.status === "failed" ? "danger" : s.status === "done" ? "ok" : "neutral"}>{statusLabel(s.status)}</Badge>
                      {s.conversation_id ? <Link className="btn sm ghost" to={`/assistant/${s.conversation_id}`}>Open the job</Link> : null}
                    </div>
                    {s.result && <details><summary className="muted small">Result</summary><div className="lead-text">{s.result}</div></details>}
                  </li>
                ))}
              </ol>
              <div className="lead-synth">
                <h3 className="small">Answer</h3>
                {r.synthesis ? <div className="lead-text">{r.synthesis}</div> : <div className="muted small">Written when every sub-task has finished.</div>}
                {r.conversation_id ? <Link className="btn sm" to={`/assistant/${r.conversation_id}`}>Open the chat that started it</Link> : null}
              </div>
            </>}
          </article>
        );
      })}
    </section>
  );
}
