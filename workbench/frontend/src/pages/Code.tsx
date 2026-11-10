// Code: the terminal, the browser, the computer, and coding jobs handed to Rooks, Claude Code or Codex.
// Premium pass (package C): primitives, a loading, an empty and an error state, one column on a phone.
import { CheckCircle2, CircleStop, Code2, FolderOpen, Plus, Send, Terminal, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { TerminalSlot } from "../terminalHost";
import { Markdown, useToast } from "../util";
import { ApprovalCard, Badge, Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Select, Tabs, Textarea } from "../ui";
import { Gate, Split, StatusText, plainError, useLoad } from "./agents/kit";
import Browser from "./Browser";
import Computer from "./Computer";

export type CliAgent = {
  id: "rooks" | "claude" | "codex"; name: string; plan: string; install: string; login: string; login_hint: string; docs: string; terms: string;
  installed: boolean; version: string; signed_in: boolean; auth: "subscription" | "api_key" | "workspace" | "none"; ready: boolean; detail: string;
};
type RunSummary = { id: string; agent: string; agent_name: string; task: string; folder: string; mode: string; status: string; created_at: number };
type Ev = { kind: string; t: number; text?: string; tool?: string; label?: string; input?: string; id?: string; error?: boolean; sub?: boolean; model?: string };
type Pending = { id: string; tool: string; rule: string; label: string; input: string };
type Run = RunSummary & {
  events: Ev[]; event_count: number; pending: Pending[]; result: string; error: string; cost_usd: number | null; tokens_in: number;
  tokens_out: number; model: string; diff: string; files: string[]; session: boolean;
};

const MODES: { id: string; label: string; hint: string }[] = [
  { id: "ask", label: "Ask first", hint: "Reads freely. Asks you before it edits a file or runs a command." },
  { id: "edits", label: "Edit files", hint: "Edits files in this folder on its own. Still asks before commands." },
  { id: "plan", label: "Plan only", hint: "Reads and proposes. Changes nothing." },
];
const active = (s: string) => s === "queued" || s === "running";
const STATUS: Record<string, string> = { queued: "Starting", running: "Working", needs_approval: "Needs you", done: "Done", failed: "Didn't finish", stopped: "Stopped" };

function ago(ts: number) {
  const s = Date.now() / 1000 - ts;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(ts * 1000).toLocaleDateString();
}

/** Install / sign-in guidance for one CLI. Used here and in onboarding. */
export function AgentSetup({ agent, onRecheck, checking }: { agent: CliAgent; onRecheck: () => void; checking?: boolean }) {
  return (
    <div className="cli-setup">
      <div className="ag-bar">
        <span className={`ag-dot ${agent.ready ? "is-ok" : agent.installed ? "is-warn" : ""}`} aria-hidden />
        <strong className="ag-grow">{agent.ready
          ? (agent.auth === "workspace" ? "Ready. Uses the models already connected here" : agent.auth === "subscription" ? "Ready, signed in with your plan" : "Ready, signed in with an API key")
          : agent.installed ? "Installed, not signed in" : "Not installed"}</strong>
        <Button size="sm" variant="ghost" onClick={onRecheck} busy={checking}>{checking ? "Checking…" : "Check again"}</Button>
      </div>
      {!agent.ready && agent.id === "rooks" && (
        <ol className="cli-steps">
          <li>{agent.detail || "The coding assistant is not installed on this computer."}</li>
          <li>Install it, then press Check again.</li>
        </ol>
      )}
      {!agent.ready && agent.id !== "rooks" && (
        <ol className="cli-steps">
          {!agent.installed && <li>Install it: <code>{agent.install}</code></li>}
          <li>Sign in: run <code>{agent.login}</code> in a terminal and choose your {agent.id === "claude" ? "Claude" : "ChatGPT"} account.</li>
          <li>Come back and press Check again.</li>
        </ol>
      )}
      {agent.ready && agent.auth === "api_key" && <p className="ag-note">{agent.detail}</p>}
      {agent.ready && agent.version && <p className="ag-note">{agent.name} {agent.version.replace(/\(.*\)/, "").trim()}</p>}
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="diff">{diff.split("\n").map((l, i) => {
      const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "meta"
        : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
      return <span key={i} className={cls}>{l}{"\n"}</span>;
    })}</pre>
  );
}

function EventRow({ e }: { e: Ev }) {
  if (e.kind === "user") return <div className="cev cev-user">{e.text}</div>;
  if (e.kind === "text") return <div className={`cev cev-text ${e.sub ? "sub" : ""}`}><Markdown text={e.text || ""} /></div>;
  if (e.kind === "thinking") return <details className="cev cev-think"><summary>Thinking</summary><p className="ag-note cev-pre">{e.text}</p></details>;
  if (e.kind === "tool") return (
    <details className={`cev cev-tool ${e.sub ? "sub" : ""}`}>
      <summary><Terminal size={14} aria-hidden="true" /> <span className="cev-label">{e.label}</span></summary>
      {e.input && <pre>{e.input}</pre>}
    </details>
  );
  if (e.kind === "tool_result") return e.text ? <pre className={`cev cev-out ${e.error ? "err" : ""}`}>{e.text}</pre> : null;
  if (e.kind === "approved") return <div className="cev cev-note ok"><CheckCircle2 size={14} aria-hidden="true" /> You allowed: {e.text}</div>;
  if (e.kind === "denied") return <div className="cev cev-note">{e.text}</div>;
  if (e.kind === "result") return null;
  return <div className="cev cev-note">{e.text}</div>;
}

function CodeJob() {
  const { id: raw } = useParams();
  const id = raw === "jobs" ? undefined : raw; // /code/jobs: the list and a new job, nothing open
  const navigate = useNavigate();
  const toast = useToast();
  const [agents, setAgents] = useState<CliAgent[] | null>(null);
  const [checking, setChecking] = useState(false);
  const runsState = useLoad(() => api<RunSummary[]>("/cli-agents/runs"), []);
  const runs = runsState.data ?? [];
  const [run, setRun] = useState<Run | null>(null);
  const [openErr, setOpenErr] = useState<unknown>(null);
  const [form, setForm] = useState(() => {
    const saved = JSON.parse(localStorage.getItem("wb-code-form") || "{}");
    return { agent: saved.agent || "rooks", folder: saved.folder || "", mode: saved.mode || "ask", task: "" };
  });
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  const kickUntil = useRef(0); // keep polling briefly after an action while the job restarts
  const pickedDefault = useRef(false);

  const detect = (fresh = false) => {
    setChecking(true);
    return api<{ agents: CliAgent[] }>(`/cli-agents${fresh ? "?fresh=true" : ""}`).then((r) => setAgents(r.agents)).catch(toast.err).finally(() => setChecking(false));
  };
  const loadRuns = runsState.reload;
  useEffect(() => { detect(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!agents || pickedDefault.current) return;
    pickedDefault.current = true;
    const current = agents.find((a) => a.id === form.agent);
    const rooks = agents.find((a) => a.id === "rooks");
    if (rooks?.ready && !current?.ready) setForm((f) => ({ ...f, agent: "rooks" }));
  }, [agents, form.agent]);

  useEffect(() => {
    setOpenErr(null);
    if (!id) return setRun(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<Run>(`/cli-agents/runs/${id}`);
        if (stop) return;
        setRun(r); setOpenErr(null);
        if (active(r.status) || Date.now() < kickUntil.current) timer = setTimeout(poll, 1000);
        else loadRuns();
      } catch (e) { if (!stop) setOpenErr(e); }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [id, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (run && active(run.status)) bottom.current?.scrollIntoView({ block: "nearest" }); }, [run?.event_count]);

  const chosen = agents?.find((a) => a.id === form.agent);
  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      localStorage.setItem("wb-code-form", JSON.stringify({ agent: form.agent, folder: form.folder, mode: form.mode }));
      const r = await api<Run>("/cli-agents/runs", { method: "POST", body: { agent: form.agent, task: form.task, folder: form.folder, mode: form.mode } });
      setForm({ ...form, task: "" });
      setComposing(false);
      setRun(r);
      loadRuns();
      navigate(`/code/${r.id}`);
    } catch (err) { toast.err(err); } finally { setBusy(false); }
  };
  const act = async (path: string, body?: unknown) => {
    if (!run) return;
    try {
      await api(`/cli-agents/runs/${run.id}/${path}`, { method: "POST", body: body ?? {} });
      kickUntil.current = Date.now() + 4000;
      setRun({ ...run, status: path === "deny" ? "done" : path === "stop" ? "stopped" : "running", pending: [] });
      setTick((t) => t + 1);
    } catch (err) { toast.err(err); }
  };
  const remove = async (rid: string) => {
    try { await api(`/cli-agents/runs/${rid}`, { method: "DELETE" }); if (rid === id) navigate("/code/jobs"); loadRuns(); } catch (err) { toast.err(err); }
  };

  const ready = !!chosen?.ready;
  const showComposer = composing || (!id && !run);

  const agentList = agents || ([{ id: "rooks", name: "Rooks" }, { id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }] as CliAgent[]);
  const modeNote = form.agent === "rooks" && form.mode === "edits"
    ? "Changes files and runs commands in this folder without asking. Only for a folder you trust."
    : form.agent === "rooks" && form.mode === "plan" ? "Reads the project and writes a plan. Changes nothing." : MODES.find((m) => m.id === form.mode)?.hint;

  return (
    <Page wide className="ag-page cd-page" title={showComposer ? "Code" : run?.task || "Code"} kicker={showComposer ? undefined : "Code"}
      description={showComposer ? "Pick an agent, point at a project, and say what to change. It asks before it edits or runs commands." : undefined}
      actions={<>
        {!showComposer && run && active(run.status) && <Button size="sm" icon={<CircleStop size={14} />} onClick={() => act("stop")}>Stop</Button>}
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => { setComposing(true); navigate("/code/jobs"); }}>New job</Button>
      </>}>
      <Split solo={showComposer && runsState.data?.length === 0} list={
        <Gate state={runsState} rows={4}>{(list) => list.length === 0
          ? <EmptyState icon={<Code2 size={20} />} title="No jobs yet" line="Start one with New job." />
          : <List className="ag-list" label="Jobs">
            {list.map((r) => (
              <Row key={r.id} active={r.id === id} onClick={() => { setComposing(false); navigate(`/code/${r.id}`); }} title={r.task}
                meta={<StatusText live={active(r.status)}>{STATUS[r.status] || r.status} · {r.agent_name} · {ago(r.created_at)}</StatusText>}
                actions={<IconButton size="sm" label="Delete job" onClick={() => remove(r.id)}><Trash2 size={14} /></IconButton>} />
            ))}
          </List>}
        </Gate>
      }>
        {showComposer && (
          <Card as="section" aria-label="New job">
            <form className="ag-form" onSubmit={start}>
              <Tabs label="Agent" value={form.agent} onChange={(v) => setForm({ ...form, agent: v })}
                items={agentList.map((a) => ({ id: a.id, label: a.ready ? `${a.name} · ready` : a.name }))} />
              {chosen && !ready && <AgentSetup agent={chosen} onRecheck={() => detect(true)} checking={checking} />}
              <Textarea aria-label="What should it do?" rows={3} value={form.task} onChange={(e) => setForm({ ...form, task: e.target.value })}
                placeholder="What should it do? For example: add a dark mode toggle to the settings page and run the tests" />
              <div className="ag-bar">
                <label className="cd-folder ag-grow">
                  <FolderOpen size={16} aria-hidden="true" />
                  <Input value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} placeholder="Project folder, for example ~/code/my-app" aria-label="Project folder" />
                </label>
                <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} aria-label="Permissions" className="cd-mode">
                  {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </Select>
                <Button type="submit" variant="primary" icon={<Send size={14} />} busy={busy} disabled={!ready || !form.task.trim() || !form.folder.trim()}>{busy ? "Starting…" : "Start"}</Button>
              </div>
              <p className="ag-note">{modeNote} Only use folders you trust.</p>
            </form>
          </Card>
        )}

        {!showComposer && <>
          {!run && !openErr && (id ? <Card><Loading rows={4} /></Card> : <Card><EmptyState icon={<Code2 size={20} />} title={runs.length ? "Pick a job or start one" : "No jobs yet"} line="Progress, approvals and the changes it made show up here." /></Card>)}
          {!run && !!openErr && <ErrorState title="That job did not open" line={plainError(openErr)} onRetry={() => setTick((t) => t + 1)} />}
          {run && (
            <div className="cd-run ag-stack-lg">
              <div className="ag-bar ag-meta">
                <Badge tone={run.status === "done" ? "ok" : run.status === "failed" ? "danger" : run.status === "needs_approval" ? "warn" : active(run.status) ? "live" : "neutral"}>{STATUS[run.status] || run.status}</Badge>
                <span>{run.agent_name}{run.model ? ` · ${run.model}` : ""}</span>
                <span className="ag-mono">{run.folder}</span>
                {(run.tokens_in > 0 || run.tokens_out > 0) && <span>{(run.tokens_in + run.tokens_out).toLocaleString()} tokens</span>}
              </div>
              {run.error && <ErrorState title="The job stopped" line={/Not logged in|401|Unauthorized/.test(run.error) && run.agent !== "rooks"
                ? `Sign in again in a terminal with ${run.agent === "claude" ? "claude" : "codex login"}, then retry.` : run.error} />}

              {run.pending.length > 0 && (
                <ApprovalCard title={`${run.agent_name} wants to ${run.pending.map((p) => p.label).join(", ")}`}
                  detail={run.agent === "rooks" ? "Allowing lets this step go ahead. The next change asks again." : "Allowing lets it run exactly these steps for the rest of this job."}
                  effect={run.pending.some((p) => /bash|shell|command/i.test(p.tool)) ? "command" : "write"}
                  command={run.pending.map((p) => p.input).filter(Boolean).join("\n\n") || undefined}
                  onApprove={() => act("approve")} onDeny={() => act("deny")} />
              )}

              <div className="cd-events">
                {run.events.map((e, i) => <EventRow key={i} e={e} />)}
                {active(run.status) && <StatusText live>Working…</StatusText>}
                <div ref={bottom} />
              </div>

              {run.result && !active(run.status) && run.result.trim() !== [...run.events].reverse().find((e) => e.kind === "text")?.text?.trim() && (
                <Section title="Result"><Markdown text={run.result} /></Section>
              )}

              {run.files.length > 0 && (
                <Section title={`Changes · ${run.files.length} file${run.files.length === 1 ? "" : "s"}`}>
                  {run.diff ? <DiffView diff={run.diff} /> : <p className="ag-note">{run.files.join(", ")}</p>}
                </Section>
              )}

              {!active(run.status) && run.session && run.status !== "needs_approval" && (
                <form className="ag-bar" onSubmit={(e) => { e.preventDefault(); if (reply.trim()) { act("message", { text: reply }); setReply(""); } }}>
                  <div className="ag-grow"><Input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Ask for a follow-up in the same session" aria-label="Follow-up" /></div>
                  <Button type="submit" icon={<Send size={14} />} disabled={!reply.trim()}>Send</Button>
                </form>
              )}
            </div>
          )}
        </>}
      </Split>
    </Page>
  );
}

/** One code place: a terminal that stays open, the browser, the computer, and Claude or Codex when already signed in. */
export default function Code() {
  const { id } = useParams();
  if (id) return <CodeJob />;
  return <CodeDesk />;
}

function CodeDesk() {
  const navigate = useNavigate();
  const toast = useToast();
  const [pane, setPane] = useState<"terminal" | "browser" | "computer" | "ask">("terminal");
  const [agents, setAgents] = useState<CliAgent[] | null>(null);
  const [task, setTask] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<"claude" | "codex" | "">("");

  useEffect(() => {
    api<{ agents: CliAgent[] }>("/cli-agents").then((r) => {
      setAgents(r.agents);
      const ready = r.agents.find((a) => (a.id === "claude" || a.id === "codex") && a.ready);
      if (ready?.id === "claude" || ready?.id === "codex") setWho(ready.id);
    }).catch(() => setAgents([]));
  }, []);

  const signed = (agents || []).filter((a) => (a.id === "claude" || a.id === "codex") && a.ready);
  const chosen = signed.find((a) => a.id === who) || signed[0];

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    try {
      const r = await api<Run>("/cli-agents/runs", {
        method: "POST",
        body: { agent: chosen.id, task, folder, mode: "ask" },
      });
      navigate(`/code/${r.id}`);
    } catch (err) { toast.err(err); } finally { setBusy(false); }
  };

  const tabs = [{ id: "terminal", label: "Terminal" }, { id: "browser", label: "Browser" }, { id: "computer", label: "Computer" },
    ...signed.map((a) => ({ id: `ask:${a.id}`, label: a.id === "claude" ? "Claude" : "Codex" })), { id: "jobs", label: "Jobs" }];
  const value = pane === "ask" && chosen ? `ask:${chosen.id}` : pane;
  const pick = (v: string) => {
    if (v === "jobs") { navigate("/code/jobs"); return; }
    if (v.startsWith("ask:")) { const w = v.slice(4); if (w === "claude" || w === "codex") setWho(w); setPane("ask"); return; }
    setPane(v as typeof pane);
  };

  return (
    <div className="cd-desk">
      <div className="cd-desk-bar">
        <span className="cd-desk-name">Code</span>
        <Tabs label="Code" value={value} onChange={pick} items={tabs} />
        <span className="cd-desk-note">The terminal stays as you left it. Claude and Codex show up here after you sign in.</span>
      </div>
      <div className="cd-desk-body">
        {pane === "terminal" && <TerminalSlot />}
        {pane === "browser" && <Browser />}
        {pane === "computer" && <Computer />}
        {pane === "ask" && chosen && (
          <Page className="ag-page" title={chosen.id === "claude" ? "Claude" : "Codex"} description="Hand one job to the account you already signed in to. It asks before it changes files.">
            <Card as="section" aria-label="New job">
              <form className="ag-form" onSubmit={start}>
                <Textarea label="What should it change?" rows={4} value={task} onChange={(e) => setTask(e.target.value)} />
                <Input label="Project folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="For example ~/code/my-app" />
                <div><Button type="submit" variant="primary" icon={<Send size={14} />} busy={busy} disabled={!task.trim() || !folder.trim()}>{busy ? "Starting…" : "Start"}</Button></div>
              </form>
            </Card>
          </Page>
        )}
        {pane === "ask" && !chosen && (agents === null ? <Loading rows={2} /> : <EmptyState title="Not signed in" line="Sign in to Claude or Codex in a terminal, then come back." />)}
      </div>
    </div>
  );
}
