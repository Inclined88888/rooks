// Browser agent: a goal, a real browser, the steps on the one Timeline. Premium pass (package C).
import { CheckCircle2, CircleStop, Globe, Play, Trash2, XCircle } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { LiveShot } from "../motion";
import { Markdown, ModelSelect, useModels, useToast } from "../util";
import { ApprovalCard, Badge, Button, Card, Chip, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Textarea, Timeline, type TimelineStep } from "../ui";
import { Gate, Split, StatusText, plainError, useLoad } from "./agents/kit";

type JobSummary = { id: string; goal: string; provider: string; model: string; status: string; source: string; created_at: number };
type Step = { step: number; url: string; title: string; evaluation: string; next_goal: string; actions: Record<string, unknown>[]; result?: string; status?: string; has_screenshot?: boolean };
type Approval = { id: string; category: string; label: string; action: string; description: string; url: string; answer: string | null };
type Job = JobSummary & {
  steps: Step[];
  error: string | null;
  has_screenshot: boolean;
  pending_approvals?: Approval[];
  allowed_domains: string[];
  result: { final: string | null; success: boolean | null; done: boolean; steps: number; urls: string[]; duration_s: number; model: string } | null;
};

const EXAMPLES = [
  "Go to weworkremotely.com and find three remote software engineer roles. Give title, company and link for each.",
  "On pcpartpicker.com, find a compatible CPU, motherboard and 32GB DDR5 RAM for a mid range AM5 gaming build. List prices and links.",
  "Find the current top 3 stories on news.ycombinator.com with their points.",
];

const active = (s: string) => s === "queued" || s === "running";

function ago(ts: number) {
  const s = Date.now() / 1000 - ts;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(ts * 1000).toLocaleDateString();
}
const STATUS: Record<string, string> = { queued: "Waiting to start", running: "Working", waiting: "Needs your OK", done: "Done", error: "Stopped", cancelled: "Stopped" };
const word = (s: string) => STATUS[s] ?? s;

/** The steps as the one Timeline: done steps, a step that went wrong, and the one being worked on now. */
export function browserTimeline(job: Pick<Job, "steps" | "status" | "pending_approvals">): TimelineStep[] {
  const steps: TimelineStep[] = job.steps.map((s) => ({
    id: s.step, text: s.next_goal || s.title || `Step ${s.step}`,
    state: !s.status || s.status === "ok" ? "ok" : "failed",
  }));
  if ((job.pending_approvals || []).length) steps.push({ id: "held", text: "Waiting for your OK before it goes on", state: "held" });
  else if (active(job.status)) steps.push({ id: "next", text: steps.length ? `Thinking about step ${steps.length + 1}` : "Waiting for the first step", state: "running" });
  return steps;
}

export default function Browser() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { models } = useModels();
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const jobs = useLoad(() => api<JobSummary[]>("/browser/jobs"), []);
  const [job, setJob] = useState<Job | null>(null);
  const [openErr, setOpenErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [shotKey, setShotKey] = useState(0);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [form, setForm] = useState({ goal: "", provider: "", model: "", max_steps: 8, domains: "" });
  const toast = useToast();

  const loadJobs = jobs.reload;
  useEffect(() => {
    api<{ usage: { used: number; limit: number } }>("/browser/providers").then((r) => setUsage(r.usage)).catch(() => undefined);
  }, []);

  useEffect(() => {
    setOpenErr(null); setOpenStep(null);
    if (!id) return setJob(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await api<Job>(`/browser/jobs/${id}`);
        if (stop) return;
        setJob(j); setOpenErr(null);
        setShotKey((k) => k + 1);
        if (active(j.status)) timer = setTimeout(poll, 1200);
        else loadJobs();
      } catch (e) {
        if (!stop) setOpenErr(e);
      }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [id, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (a: Approval, approve: boolean) => {
    if (!job) return;
    try {
      await api(`/browser/jobs/${job.id}/approvals/${a.id}`, { method: "POST", body: { approve } });
    } catch (e) {
      toast.err(e);
    }
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const j = await api<Job>("/browser/jobs", {
        body: {
          goal: form.goal, provider: "workbench", model: form.model || "default", max_steps: form.max_steps,
          allowed_domains: form.domains.split(",").map((d) => d.trim()).filter(Boolean),
        },
      });
      loadJobs();
      navigate(`/browser/${j.id}`);
    } catch (err) {
      toast.err(err);
    }
  };
  const cancel = async () => { try { await api(`/browser/jobs/${job!.id}/cancel`, { method: "POST" }); } catch (e) { toast.err(e); } };
  const remove = async (jid: string) => {
    try { await api(`/browser/jobs/${jid}`, { method: "DELETE" }); } catch (e) { toast.err(e); return; }
    if (job?.id === jid) navigate("/browser");
    loadJobs();
  };

  const picked = job?.steps.find((s) => s.step === openStep) ?? null;
  const modelName = (() => { const m = job?.result?.model || job?.model || ""; return !m || m === "default" || m.startsWith("auto") ? "Auto" : m.split("/").pop(); })();

  return (
    <Page wide className="ag-page br-page" title="Browser agent" description="Describe a goal. The agent opens a real browser, clicks, types and reads until it is done.">
      <div className="ag-stack-lg">
        <Card as="section" aria-label="New run">
          <form className="ag-form" onSubmit={start}>
            <Textarea aria-label="The goal" rows={3} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} placeholder="For example: find three remote software engineer roles on weworkremotely.com" />
            {!form.goal && (
              <div className="ag-bar">
                <span className="ag-meta">Try</span>
                {EXAMPLES.map((ex) => <Chip key={ex} title={ex} onClick={() => setForm({ ...form, goal: ex })}>{ex.length > 44 ? ex.slice(0, 42) + "…" : ex}</Chip>)}
              </div>
            )}
            <div className="ag-bar">
              <div className="rs-model"><ModelSelect value={form.model} onChange={(model) => setForm({ ...form, model })} models={models} /></div>
              <div className="br-steps"><Input type="number" aria-label="Stop after this many steps" min={1} max={12} value={form.max_steps} onChange={(e) => setForm({ ...form, max_steps: Math.min(12, Math.max(1, Number(e.target.value) || 8)) })} /></div>
              <span className="ag-meta">steps</span>
              <div className="ag-grow br-domains"><Input value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} aria-label="Only these sites" placeholder="Only these sites (optional): *.pcpartpicker.com, …" /></div>
              <Button type="submit" variant="primary" icon={<Play size={14} />} disabled={form.goal.trim().length < 3}>Run</Button>
            </div>
            <p className="ag-note">
              It stops after the number you set. It does not run without a limit. Models that can see pictures work best.
              {usage && usage.limit ? <> {usage.used} of {usage.limit} browser steps used this month.</> : null}
            </p>
          </form>
        </Card>

        <Split solo={!id && jobs.data?.length === 0} list={
          <Gate state={jobs} rows={4}>{(list) => list.length === 0
            ? <EmptyState icon={<Globe size={20} />} title="No runs yet" line="Start one above. Chat can use this browser too." />
            : <List className="ag-list" label="Runs">
              {list.map((j) => (
                <Row key={j.id} active={job?.id === j.id} onClick={() => navigate(`/browser/${j.id}`)} title={j.goal}
                  meta={<StatusText live={active(j.status)}>{word(j.status)}{j.source && j.source !== "api" ? ` · from ${j.source}` : ""} · {ago(j.created_at)}</StatusText>}
                  actions={<IconButton size="sm" label="Delete this run" onClick={() => remove(j.id)}><Trash2 size={14} /></IconButton>} />
              ))}
            </List>}
          </Gate>
        }>
          {!id && <Card><EmptyState icon={<Globe size={20} />} title={jobs.data?.length === 0 ? "No runs yet" : "Pick a run or start one"} line={jobs.data?.length === 0 ? "Start one above. Chat can use this browser too." : "Chat can use this browser too."} /></Card>}
          {id && !job && !openErr && <Card><Loading rows={4} /></Card>}
          {id && !job && !!openErr && <ErrorState title="That run did not open" line={plainError(openErr)} onRetry={() => setTick((t) => t + 1)} />}
          {job && <>
            <Card as="article" className="ag-stack">
              {active(job.status) && <span className="sr-only" role="status">Browser agent is working</span>}
              <div className="ag-panel-head">
                <h2 className="ag-title ag-grow">{job.goal}</h2>
                {active(job.status) && <Button size="sm" icon={<CircleStop size={14} />} onClick={cancel}>Stop</Button>}
              </div>
              <div className="ag-bar ag-meta">
                <Badge tone={job.status === "done" ? (job.result?.success ? "ok" : "warn") : job.status === "error" ? "danger" : active(job.status) ? "live" : "neutral"}>{word(job.status)}</Badge>
                <span>{modelName}</span>
                {job.result && <span>{job.result.steps} steps · {job.result.duration_s}s</span>}
                {job.allowed_domains.length > 0 && <span>only {job.allowed_domains.join(", ")}</span>}
              </div>
              {job.error && <ErrorState title="The run stopped" line={job.error} />}
              {(job.pending_approvals || []).map((a) => (
                <ApprovalCard key={a.id} title={`The agent is waiting for you: ${a.label}`} detail={a.description} effect="external" command={a.url}
                  onApprove={() => answer(a, true)} onDeny={() => answer(a, false)} />
              ))}
              {job.result && (
                <div className="ag-stack">
                  <div className="ag-bar">{job.result.success ? <CheckCircle2 size={16} className="ag-ok" aria-hidden="true" /> : <XCircle size={16} className="br-warn" aria-hidden="true" />}<strong>{job.result.success ? "Agent reports success" : job.result.done ? "Agent finished but did not report success" : "Stopped at the step limit"}</strong></div>
                  <p className="ag-note">This is the agent's own claim. Check it against the last screen and the steps; small models can invent answers.</p>
                  {job.result.final ? <Markdown text={job.result.final} /> : <p className="ag-note">No final answer.</p>}
                </div>
              )}
            </Card>
            <div className="ag-two br-work">
              <Section title={active(job.status) ? "Live view" : "Last screen"}>
                {job.has_screenshot ? <LiveShot src={`/api/browser/jobs/${job.id}/screenshot?k=${shotKey}`} alt="Browser screenshot" />
                  : <p className="ag-note">{active(job.status) ? "Starting the browser…" : "No picture of the screen."}</p>}
              </Section>
              <Section title="Steps">
                {job.steps.length === 0 && job.status === "waiting" && <p className="ag-note">Waiting for your approval. Nothing has been clicked or sent.</p>}
                {job.steps.length === 0 && !active(job.status) && job.status !== "waiting" && <p className="ag-note">No steps recorded.</p>}
                <Timeline label="Browser steps" steps={browserTimeline(job)} current={openStep ?? undefined}
                  onPick={(sid) => typeof sid === "number" && setOpenStep(openStep === sid ? null : sid)} />
                {picked && (
                  <div className="ag-panel is-sunken ag-stack ag-gap-top" aria-label={`Step ${picked.step}`}>
                    {picked.evaluation && <p className="ag-body"><span className="ag-meta">Thinking: </span>{picked.evaluation}</p>}
                    {picked.result && <p className="ag-note">{picked.result}</p>}
                    {picked.title && <p className="ag-meta">{picked.title}</p>}
                    {picked.has_screenshot && <img className="ag-shot" src={`/api/browser/jobs/${job.id}/screenshot/${picked.step}`} alt={`The screen at step ${picked.step}`} loading="lazy" />}
                    <details className="ag-advanced">
                      <summary>Advanced</summary>
                      <pre className="ag-pre">{[picked.url, ...picked.actions.map((a) => { const [name, args] = Object.entries(a)[0] || ["", {}]; return `${name}${args && Object.keys(args as object).length ? ` ${JSON.stringify(args)}` : ""}`; })].filter(Boolean).join("\n")}</pre>
                    </details>
                  </div>
                )}
                {job.steps.length > 0 && !picked && <p className="ag-note ag-gap-top">Pick a step to see what it saw and did.</p>}
              </Section>
            </div>
          </>}
        </Split>
      </div>
    </Page>
  );
}
