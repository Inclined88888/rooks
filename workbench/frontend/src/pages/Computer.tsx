// Computer (Rooks Desk): a task, your apps and files, the steps on the one Timeline. Premium pass (package C).
import { CheckCircle2, CircleStop, FolderOpen, Monitor, OctagonX, Play, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { LiveShot } from "../motion";
import { SurfaceNote } from "../SurfaceNote";
import { Markdown, ModelSelect, useModels, useToast } from "../util";
import { ApprovalCard, Badge, Button, Card, Chip, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Textarea, Timeline, type TimelineStep } from "../ui";
import { Gate, Split, StatusText, plainError, useLoad } from "./agents/kit";

type JobSummary = { id: string; goal: string; provider: string; model: string; status: string; source: string; created_at: number; dry_run: boolean };
type Step = {
  step: number; app: string; title: string; thought: string; action: string; args: Record<string, unknown>; result: string;
  status: string; approval?: string | null; output?: string; elapsed_ms?: number;
};
type Approval = { id: string; category: string; action: string; summary: string; detail: string; answer: boolean | null; step?: number; timed_out?: boolean };
type Result = {
  final: string | null; success: boolean | null; done: boolean; steps: number; dry_run: boolean; stopped: string; errors: string[];
  denied: string[]; files: string[]; commands: { command: string; exit_code: number | null; output?: string }[]; duration_s: number; model: string;
};
type Job = JobSummary & {
  steps: Step[]; error: string | null; has_screenshot: boolean; pending_approvals?: Approval[]; approvals: Approval[];
  result: Result | null; live: { step: number; output: string } | null;
};
type Perm = { ok: boolean; how?: string };
type DeskStatus = {
  backend: string | null; ok: boolean; error?: string; platform: string; hotkey: string; running: string | null;
  permissions?: Record<string, Perm>; accessibility?: [boolean, string];
  policy: { folders: string[]; allow_apps: string[]; deny_apps: string[] };
};

const CATEGORY: Record<string, string> = {
  shell: "Run a command", danger: "A risky command", file_write: "Write a file outside your folders", file_read: "Read a file outside your folders",
  file_delete: "Delete a file", message: "Send a message or email", purchase: "Pay or place an order", login: "Sign in or enter a password",
  app: "Use an app that is not on your list", mcp: "Use a connected add-on tool", system: "A system shortcut",
};
const EXAMPLES = [
  "Open the text editor, write a short packing list for a weekend trip and save it as packing.txt in Documents.",
  "In the terminal, show how much disk space is free and list the 5 biggest files in Downloads.",
  "Open my Documents folder in the file manager and tell me what is in it.",
];
/** Categories a person may let one task do without stopping to ask. Logins and dangerous commands always ask. */
const SKIP_ASKING: [string, string][] = [["shell", "Run commands"], ["file_write", "Save files outside my folders"], ["message", "Send emails"]];
const active = (s: string) => s === "queued" || s === "running" || s === "waiting";

function ago(ts: number) {
  const s = Date.now() / 1000 - ts;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(ts * 1000).toLocaleDateString();
}
const STATUS: Record<string, string> = { queued: "Waiting to start", running: "Working", waiting: "Waiting for you", done: "Done", error: "Stopped", cancelled: "Stopped" };
const word = (s: string) => STATUS[s] ?? s;

function describe(s: Step) {
  const a = s.args || {};
  const bits = Object.entries(a).filter(([k]) => k !== "thought").map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `${s.action}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

/** The desk steps as the one Timeline: what it did, what you said no to or went wrong, and what it is on now. */
export function deskTimeline(job: Pick<Job, "steps" | "status" | "pending_approvals">): TimelineStep[] {
  const steps: TimelineStep[] = job.steps.map((s) => ({
    id: s.step, text: describe(s), state: s.status === "denied" || s.status === "error" ? "failed" : "ok",
  }));
  if ((job.pending_approvals || []).length || job.status === "waiting") steps.push({ id: "held", text: "Waiting for your answer", state: "held" });
  else if (active(job.status)) steps.push({ id: "next", text: steps.length ? `Working on step ${steps.length + 1}` : "Looking at the screen", state: "running" });
  return steps;
}

export default function Computer() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { models } = useModels();
  const [desk, setDesk] = useState<DeskStatus | null>(null);
  const jobsState = useLoad(() => api<JobSummary[]>("/desk/jobs"), []);
  const jobs = jobsState.data ?? [];
  const [job, setJob] = useState<Job | null>(null);
  const [openErr, setOpenErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [shotKey, setShotKey] = useState(0);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [form, setForm] = useState({ goal: "", model: "", max_steps: 12, dry_run: false, approve: [] as string[] });
  const [lists, setLists] = useState<{ folders: string; allow_apps: string } | null>(null);
  const [turn, setTurn] = useState<{ reason?: string } | null>(null);
  const toast = useToast();

  const loadJobs = jobsState.reload;
  const loadDesk = () => api<DeskStatus>("/desk/status").then((d) => {
    setDesk(d);
    setLists((l) => l ?? { folders: d.policy.folders.join("\n"), allow_apps: d.policy.allow_apps.join(", ") });
  }).catch(toast.err);
  useEffect(() => { loadDesk(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api<{ reason?: string }>("/desk/handoff").then((h) => setTurn(h?.reason ? h : null)).catch(() => {});
  }, []);

  useEffect(() => {
    setOpenErr(null); setOpenStep(null);
    if (!id) return setJob(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await api<Job>(`/desk/jobs/${id}`);
        if (stop) return;
        setJob(j); setOpenErr(null);
        setShotKey((k) => k + 1);
        if (active(j.status)) timer = setTimeout(poll, 1000);
        else loadJobs();
      } catch (e) {
        if (!stop) setOpenErr(e);
      }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [id, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (a: Approval, approve: boolean) => {
    try {
      await api(`/desk/jobs/${job!.id}/approvals/${a.id}`, { method: "POST", body: { approve } });
    } catch (e) {
      toast.err(e);
    }
  };
  const start = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const j = await api<Job>("/desk/jobs", { body: { goal: form.goal, provider: "workbench", model: form.model || "default", max_steps: form.max_steps, dry_run: form.dry_run, approve: form.approve } });
      loadJobs();
      navigate(`/computer/${j.id}`);
    } catch (err) {
      toast.err(err);
    }
  };
  const stopAll = async () => {
    try {
      await api("/desk/stop", { method: "POST" });
      toast.ok("Stopped. Nothing else will be clicked or typed.");
    } catch (e) {
      toast.err(e);
    }
  };
  const cancel = async (jid: string) => { try { await api(`/desk/jobs/${jid}/cancel`, { method: "POST" }); } catch (e) { toast.err(e); } };
  const remove = async (jid: string) => {
    try { await api(`/desk/jobs/${jid}`, { method: "DELETE" }); } catch (e) { toast.err(e); return; }
    if (job?.id === jid) navigate("/computer");
    loadJobs();
  };
  const saveLists = async () => {
    if (!lists) return;
    try {
      await api("/desk/settings", { method: "PUT", body: {
        folders: lists.folders.split("\n").map((f) => f.trim()).filter(Boolean),
        allow_apps: lists.allow_apps.split(",").map((f) => f.trim()).filter(Boolean),
      } });
      toast.ok("Saved");
      loadDesk();
    } catch (e) {
      toast.err(e);
    }
  };

  const missing = Object.entries(desk?.permissions || {}).filter(([, p]) => !p.ok);
  const anyRunning = jobs.some((j) => active(j.status)) || (job && active(job.status));

  const picked = job?.steps.find((s) => s.step === openStep) ?? null;
  const hotkey = desk?.hotkey || "Ctrl+Alt+Esc";

  return (
    <Page wide className="ag-page br-page" title="Computer"
      description="Describe a task and watch it use your apps, files and terminal to do it. It asks you first before anything that matters, and Stop everything halts it at once."
      actions={<Button variant="danger" icon={<OctagonX size={16} />} onClick={stopAll} title={`Or press ${hotkey} anywhere`} disabled={!anyRunning}>Stop everything</Button>}>
      <div className="ag-stack-lg">
        {turn?.reason && (
          <Card className="cm-turn">
            <h3 className="ag-h3">Your turn</h3>
            <p className="ag-body">{turn.reason}</p>
            <p className="ag-note">Finish this step on this computer. I will not type a password or click for you.</p>
          </Card>
        )}

        <SurfaceNote />
        {desk && !desk.ok && <ErrorState title="Rooks Desk cannot see this screen" line={desk.error || "Check the screen permissions, then try again."} onRetry={loadDesk} />}
        {missing.length > 0 && <PermissionSteps missing={missing.map(([k]) => k)} platform={desk?.platform} onRecheck={loadDesk} />}

        <Card as="section" aria-label="New task">
          <form className="ag-form" onSubmit={start}>
            <Textarea aria-label="The task" rows={3} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })}
              placeholder="For example: open the text editor, write my packing list and save it in Documents" />
            {!form.goal && <div className="ag-bar">
              <span className="ag-meta">Try</span>
              {EXAMPLES.map((ex) => <Chip key={ex} title={ex} onClick={() => setForm({ ...form, goal: ex })}>{ex.slice(0, 52)}…</Chip>)}
            </div>}
            <div className="ag-bar">
              <div className="rs-model"><ModelSelect value={form.model} onChange={(model) => setForm({ ...form, model })} models={models} /></div>
              <div className="br-steps"><Input type="number" aria-label="Stop after this many steps" min={1} max={16} value={form.max_steps} onChange={(e) => setForm({ ...form, max_steps: Math.min(16, Math.max(1, Number(e.target.value) || 12)) })} /></div>
              <span className="ag-meta">steps</span>
              <label className="ag-check"><input type="checkbox" checked={form.dry_run} onChange={(e) => setForm({ ...form, dry_run: e.target.checked })} /> Dry run (look and plan, change nothing)</label>
              <span className="ag-bar-end"><Button type="submit" variant="primary" icon={<Play size={14} />} disabled={form.goal.trim().length < 3}>Start</Button></span>
            </div>
            <fieldset className="cm-skip">
              <legend className="ag-meta">Don't ask me this time before it:</legend>
              {SKIP_ASKING.map(([cat, label]) => (
                <label key={cat} className="ag-check"><input type="checkbox" checked={form.approve.includes(cat)}
                  onChange={(e) => setForm({ ...form, approve: e.target.checked ? [...form.approve, cat] : form.approve.filter((c) => c !== cat) })} /> {label}</label>
              ))}
              <span className="ag-note">Sign-ins, passwords and risky commands still ask.</span>
            </fieldset>
            <p className="ag-note">
              It stops after the number you set. It does not run without a limit. While it works you see a frame around the screen.
              Move the mouse to the top-left corner, press <kbd className="ag-mono">{hotkey}</kbd> or Stop to halt it at once.
              Models that can see pictures of the screen work best; others read the window's text.
            </p>
          </form>
        </Card>

        <Split list={
          <div className="ag-stack-lg">
            <Gate state={jobsState} rows={4}>{(list) => list.length === 0
              ? <EmptyState icon={<Monitor size={20} />} title="No tasks yet" line="Start one above. Chat and Rooks Code can use your computer too." />
              : <List className="ag-list" label="Tasks">
                {list.map((j) => (
                  <Row key={j.id} active={job?.id === j.id} onClick={() => navigate(`/computer/${j.id}`)} title={j.goal}
                    meta={<StatusText live={active(j.status)}>{word(j.status)}{j.dry_run ? " · dry run" : ""} · {j.source} · {ago(j.created_at)}</StatusText>}
                    actions={<IconButton size="sm" label="Delete this task" onClick={() => remove(j.id)}><Trash2 size={14} /></IconButton>} />
                ))}
              </List>}
            </Gate>
            {lists && (
              <Card as="section" className="ag-form" aria-labelledby="cm-touch-h">
                <h3 id="cm-touch-h" className="ag-h3 ag-bar"><FolderOpen size={16} aria-hidden="true" /> What it may touch</h3>
                <Textarea label="Folders it can read and write without asking (one per line)" className="ag-mono" rows={4} value={lists.folders} onChange={(e) => setLists({ ...lists, folders: e.target.value })} />
                <Input label="Apps it can use without asking" hint="Separate with commas. Empty means any app except password managers." value={lists.allow_apps} onChange={(e) => setLists({ ...lists, allow_apps: e.target.value })} placeholder="Text Editor, Terminal, AutoCAD" />
                <div><Button size="sm" onClick={saveLists}>Save</Button></div>
                <p className="ag-note">Always asks: commands, files elsewhere, emails and messages, purchases, logins. Never: password fields.</p>
              </Card>
            )}
          </div>
        }>
          {!id && (
            <Card className="ag-stack">
              <EmptyState icon={<Monitor size={20} />} title="Start a task or pick one" line="Chat and Rooks Code can use your computer too; their tasks show up here." />
              {desk?.ok && <img className="ag-shot" src={`/api/desk/screen?k=${shotKey}`} alt="Your screen now" />}
            </Card>
          )}
          {id && !job && !openErr && <Card><Loading rows={4} /></Card>}
          {id && !job && !!openErr && <ErrorState title="That task did not open" line={plainError(openErr)} onRetry={() => setTick((t) => t + 1)} />}
          {job && <>
            <Card as="article" className="ag-stack">
              {active(job.status) && <span className="sr-only" role="status">Using your computer</span>}
              <div className="ag-panel-head">
                <h2 className="ag-title ag-grow">{job.goal}</h2>
                {active(job.status) && <Button size="sm" icon={<CircleStop size={14} />} onClick={() => cancel(job.id)}>Stop</Button>}
              </div>
              <div className="ag-bar ag-meta">
                <Badge tone={job.status === "done" ? (job.result?.success ? "ok" : "warn") : job.status === "error" ? "danger" : job.status === "waiting" ? "warn" : active(job.status) ? "live" : "neutral"}>{word(job.status)}</Badge>
                {job.dry_run && <Badge>Dry run</Badge>}
                {job.result && <span>{job.result.steps} steps · {job.result.duration_s}s</span>}
              </div>
              {job.error && <ErrorState title="The task stopped" line={job.error} />}
              {(job.pending_approvals || []).map((a) => (
                <ApprovalCard key={a.id} title={`Allow this? ${CATEGORY[a.category] || a.category}`} detail={a.summary}
                  effect={a.category === "message" ? "send" : a.category === "shell" || a.category === "danger" ? "command" : a.category.startsWith("file") ? "write" : "external"}
                  command={a.detail || undefined} onApprove={() => answer(a, true)} onDeny={() => answer(a, false)} />
              ))}
              {job.result && (
                <div className="ag-stack">
                  <div className="ag-bar">{job.result.success ? <CheckCircle2 size={16} className="ag-ok" aria-hidden="true" /> : <XCircle size={16} className="br-warn" aria-hidden="true" />}
                    <strong>{job.result.stopped ? `Stopped: ${job.result.stopped}` : job.result.success ? "Rooks Desk reports success" : job.result.done ? "Finished without success" : "Stopped at the step limit"}</strong></div>
                  <p className="ag-note">This is the agent's own claim. Check the last screen, files and steps below.</p>
                  {job.result.final ? <Markdown text={job.result.final} /> : <p className="ag-note">No final answer.</p>}
                  {job.result.files.length > 0 && <p className="ag-meta">Files: <span className="ag-mono">{job.result.files.join(", ")}</span></p>}
                  {job.result.denied.length > 0 && <p className="ag-meta">You said no to: {job.result.denied.join("; ")}</p>}
                </div>
              )}
              <details className="ag-advanced"><summary>Advanced</summary><p className="ag-meta ag-mono">{job.provider}{job.result?.model ? `/${job.result.model}` : job.model ? `/${job.model}` : ""}</p></details>
            </Card>
            <div className="ag-two br-work">
              <Section title={active(job.status) ? "Live screen" : "Last screen"}>
                {job.has_screenshot ? <LiveShot src={`/api/desk/jobs/${job.id}/screenshot?k=${shotKey}`} alt="Screen" />
                  : <p className="ag-note">{active(job.status) ? "Looking at the screen…" : "No picture of the screen."}</p>}
                {job.live?.output && active(job.status) && <pre className="ag-pre ag-gap-top">{job.live.output}</pre>}
              </Section>
              <Section title="Thinking and actions">
                {job.steps.length === 0 && !active(job.status) && <p className="ag-note">No steps recorded.</p>}
                <Timeline label="Computer steps" steps={deskTimeline(job)} current={openStep ?? undefined}
                  onPick={(sid) => typeof sid === "number" && setOpenStep(openStep === sid ? null : sid)} />
                {picked && (
                  <div className="ag-panel is-sunken ag-stack ag-gap-top" aria-label={`Step ${picked.step}`}>
                    {picked.status && picked.status !== "ok" && <div><Badge tone={picked.status === "denied" || picked.status === "error" ? "danger" : "warn"}>{picked.status === "denied" ? "You said no" : picked.status === "error" ? "Went wrong" : picked.status}</Badge></div>}
                    {picked.thought && <p className="ag-body"><span className="ag-meta">Thinking: </span>{picked.thought}</p>}
                    {picked.result && <p className="ag-note">{picked.result}</p>}
                    {picked.output && <pre className="ag-pre">{picked.output}</pre>}
                    <p className="ag-meta">{picked.app}{picked.title && picked.title !== picked.app ? ` · ${picked.title}` : ""}</p>
                    <img className="ag-shot" src={`/api/desk/jobs/${job.id}/screenshot/${picked.step}`} alt={`The screen at step ${picked.step}`} loading="lazy"
                      onError={(e) => { e.currentTarget.hidden = true; }} />
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


/** macOS asks once for two switches. Each button shows macOS's own prompt or opens the right System Settings page. */
function PermissionSteps({ missing, platform, onRecheck }: { missing: string[]; platform?: string; onRecheck: () => void }) {
  const [asked, setAsked] = useState(false);
  const screen = missing.includes("screen");
  const control = missing.includes("input") || missing.includes("accessibility");
  const ask = async () => { await api("/desk/permissions/request", { method: "POST" }).catch(() => undefined); setAsked(true); onRecheck(); };
  const open = (which: "screen" | "input") => api("/desk/permissions/open", { body: { which } }).catch(() => undefined);
  if (platform && platform !== "darwin") {
    return <ErrorState title="This computer has not allowed screen control yet" line={`Still needed: ${missing.join(", ")}.`} onRetry={onRecheck} />;
  }
  return (
    <Card as="section" className="ag-stack" aria-labelledby="cm-perm-h">
      <h3 id="cm-perm-h" className="ag-h3 ag-bar"><ShieldAlert size={16} aria-hidden="true" /> One-time setup: let it see and use your screen</h3>
      <p className="ag-note">macOS asks you to allow this once. Nothing happens on your screen until you start a task.</p>
      <ol className="free-steps">
        <li className={asked ? "done" : ""}>
          <span className="free-n">1</span>
          <span className="grow">Ask macOS for permission. Click Allow (or Open System Settings) in the boxes that pop up.</span>
          <Button size="sm" variant="primary" onClick={ask}>Ask macOS</Button>
        </li>
        {screen && <li>
          <span className="free-n">2</span>
          <span className="grow">In <strong>Screen &amp; System Audio Recording</strong>, switch on <strong>AI Workspace</strong> (or python, if that's what's listed).</span>
          <Button size="sm" onClick={() => open("screen")}>Open it</Button>
        </li>}
        {control && <li>
          <span className="free-n">{screen ? 3 : 2}</span>
          <span className="grow">In <strong>Accessibility</strong>, switch on the same app.</span>
          <Button size="sm" onClick={() => open("input")}>Open it</Button>
        </li>}
        <li>
          <span className="free-n">{1 + (screen ? 1 : 0) + (control ? 1 : 0) + 1}</span>
          <span className="grow">macOS applies it after a restart: quit AI Workspace and open it again, then check.</span>
          <Button size="sm" variant="ghost" onClick={onRecheck}>Check again</Button>
        </li>
      </ol>
    </Card>
  );
}
