// Company: you are the board. Mission, an org chart of agents, a task board, spend caps. Premium pass (package C).
import { Building2, Pause, Play, Plus, Trash2, UserPlus, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Markdown, ModelSelect, relTime, useModels, useToast } from "../util";
import { Badge, Button, Card, EmptyState, IconButton, Input, Page, Section, Select, Sheet, Textarea } from "../ui";
import { Gate, useLoad } from "./agents/kit";
import "./agents/company.css";

type Agent = { id: number; name: string; title: string; reports_to: number | null; model: string; instructions: string; monthly_budget_cents: number;
  monthly_token_limit: number; status: string; paused_reason: string; month: { cents: number; tokens: number; unpriced_calls: number } };
type Task = { id: number; title: string; description: string; agent_id: number | null; agent_name: string | null; status: string; result: string;
  created_by: string; conversation_id: number | null; updated_at: string };
type Overview = { mission: string; agents: Agent[]; tasks: Task[] };

const COLUMNS: [string, string[]][] = [["To do", ["todo"]], ["Queued", ["queued"]], ["Running", ["running"]], ["Done", ["done"]], ["Needs you", ["failed", "blocked"]]];
const blank = { name: "", title: "", reports_to: null as number | null, model: "", instructions: "", monthly_budget_cents: 500, monthly_token_limit: 0 };

function OrgNode({ agent, all, onEdit }: { agent: Agent; all: Agent[]; onEdit: (a: Agent) => void }) {
  const reports = all.filter((a) => a.reports_to === agent.id);
  const pct = agent.monthly_budget_cents ? Math.min(100, (agent.month.cents / agent.monthly_budget_cents) * 100) : 0;
  return (
    <div className="co-node">
      <button type="button" className={`co-person${agent.status === "paused" ? " is-paused" : ""}`} onClick={() => onEdit(agent)}>
        <span className="co-person-head"><strong className="ag-grow">{agent.name}</strong>{agent.status === "paused" && <Badge tone="danger">Paused</Badge>}</span>
        <span className="ag-meta">{agent.title || "Team member"}</span>
        <span className="ag-meta ag-num">
          {agent.monthly_budget_cents ? `$${(agent.month.cents / 100).toFixed(2)} of $${(agent.monthly_budget_cents / 100).toFixed(2)}` : `$${(agent.month.cents / 100).toFixed(2)} · no money cap`}
        </span>
        {agent.monthly_budget_cents > 0 && <span className={`co-bar${pct >= 80 ? " is-high" : ""}`} aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>}
      </button>
      {reports.length > 0 && (
        <div className="co-reports">
          {reports.map((r) => <OrgNode key={r.id} agent={r} all={all} onEdit={onEdit} />)}
        </div>
      )}
    </div>
  );
}

export default function Company() {
  const overview = useLoad(() => api<Overview>("/company").then((d) => { setMission((m) => m || d.mission); return d; }), []);
  const data = overview.data ?? { mission: "", agents: [], tasks: [] };
  const [mission, setMission] = useState("");
  const [edit, setEdit] = useState<(typeof blank & { id?: number }) | null>(null);
  const [task, setTask] = useState({ title: "", description: "", agent_id: 0 });
  const [open, setOpen] = useState<number | null>(null);
  const { models } = useModels();
  const toast = useToast();

  const load = overview.reload;
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const saveAgent = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    try {
      const body = { ...edit, reports_to: edit.reports_to || null };
      if (edit.id) await api(`/company/agents/${edit.id}`, { method: "PUT", body }); else await api("/company/agents", { body });
      setEdit(null); load();
    } catch (err) { toast.err(err); }
  };
  const addTask = async (start: boolean) => {
    try { await api("/company/tasks", { body: { ...task, agent_id: task.agent_id || null, start } }); setTask({ title: "", description: "", agent_id: task.agent_id }); load(); }
    catch (e) { toast.err(e); }
  };
  const patchTask = async (t: Task, body: Record<string, unknown>) => { try { await api(`/company/tasks/${t.id}`, { method: "PATCH", body }); load(); } catch (e) { toast.err(e); } };
  const setStatus = async (a: Agent, status: string) => { try { await api(`/company/agents/${a.id}/status`, { body: { status } }); load(); } catch (e) { toast.err(e); } };
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); load(); } catch (e) { toast.err(e); } };

  const roots = data.agents.filter((a) => !a.reports_to || !data.agents.some((b) => b.id === a.reports_to));
  const spend = data.agents.reduce((s, a) => s + a.month.cents, 0);
  const unpriced = data.agents.some((a) => a.month.unpriced_calls > 0 && a.monthly_budget_cents > 0);
  const editing = edit?.id ? data.agents.find((x) => x.id === edit.id) : undefined;

  return (
    <Page wide className="ag-page co-page" title="Company" description="You are the board. Set the mission, hire agents, assign work, cap spend. One task runs at a time."
      actions={<><Badge>${(spend / 100).toFixed(2)} this month</Badge><Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setEdit({ ...blank })}>Hire</Button></>}>
      <Gate state={overview} rows={5}>{() => <>
        <Section title="Mission">
          <div className="ag-bar co-mission">
            <div className="ag-grow"><Textarea aria-label="Mission" rows={2} value={mission} onChange={(e) => setMission(e.target.value)} placeholder="What is this company trying to achieve?" /></div>
            <Button disabled={mission === data.mission} onClick={() => act(async () => { await api("/company/mission", { method: "PUT", body: { mission } }); toast.ok("Mission saved"); })}>Save</Button>
          </div>
          {unpriced && <p className="ag-note co-warn">Some agents use a model with no price set, so their money budget cannot be enforced. Set prices in Settings, Usage (some models are priced automatically), or give them a token limit.</p>}
        </Section>

        <Section title="Org chart">
          {data.agents.length === 0
            ? <EmptyState icon={<Building2 size={20} />} title="No one hired yet" line="Hire a CEO, then people who report to them." action={<Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setEdit({ ...blank })}>Hire</Button>} />
            : <div className="co-chart"><div className="co-roots">{roots.map((r) => <OrgNode key={r.id} agent={r} all={data.agents} onEdit={(a) => setEdit({ ...a })} />)}</div></div>}
        </Section>

        <Section title="New task">
          <Card className="ag-form">
            <div className="ag-bar">
              <div className="ag-grow co-title"><Input aria-label="Task title" placeholder="Task title" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} /></div>
              <Select aria-label="Who does it" className="co-who" value={task.agent_id} onChange={(e) => setTask({ ...task, agent_id: Number(e.target.value) })}>
                <option value={0}>Unassigned</option>
                {data.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.title || "agent"})</option>)}
              </Select>
              <Button icon={<Plus size={14} />} disabled={!task.title.trim()} onClick={() => addTask(false)}>Add</Button>
              <Button variant="primary" icon={<Play size={14} />} disabled={!task.title.trim() || !task.agent_id} onClick={() => addTask(true)}>Add and start</Button>
            </div>
            <Textarea aria-label="Details" rows={2} placeholder="Details (optional)" value={task.description} onChange={(e) => setTask({ ...task, description: e.target.value })} />
          </Card>
        </Section>

        <Section title="Work">
          <div className="co-board">
            {COLUMNS.map(([label, statuses]) => {
              const list = data.tasks.filter((t) => statuses.includes(t.status));
              return (
                <section key={label} className="co-col" aria-label={label}>
                  <div className="co-col-head"><h3 className="ag-h3 ag-grow">{label}</h3><span className={`ag-meta ag-num${label === "Needs you" && list.length ? " co-needs" : ""}`}>{list.length}</span></div>
                  {list.length === 0 && <p className="ag-note co-none">Nothing here.</p>}
                  {list.map((t) => (
                    <article key={t.id} className="co-task">
                      <div className="co-task-head">
                        <button type="button" className="co-task-title" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>{t.title}</button>
                        <IconButton size="sm" label={`Delete ${t.title}`} onClick={() => act(() => api(`/company/tasks/${t.id}`, { method: "DELETE" }))}><X size={14} /></IconButton>
                      </div>
                      <p className="ag-meta">{t.agent_name ?? "Unassigned"} · {t.created_by === "board" ? "from you" : "delegated"} · {relTime(t.updated_at)}</p>
                      {open === t.id && (t.result ? <Markdown text={t.result} /> : <p className="ag-note">{t.description || "No details."}</p>)}
                      {open === t.id && t.conversation_id && <Link className="ag-meta" to={`/assistant/${t.conversation_id}`}>Open work log</Link>}
                      {["todo", "failed", "blocked", "done"].includes(t.status) && t.agent_id && (
                        <div><Button size="sm" icon={<Play size={14} />} onClick={() => patchTask(t, { status: "queued" })}>{t.status === "todo" ? "Start" : "Run again"}</Button></div>
                      )}
                    </article>
                  ))}
                </section>
              );
            })}
          </div>
        </Section>
      </>}</Gate>

      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : "Hire an agent"} width={480}
        footer={edit && <div className="ag-bar">
          {edit.id && <IconButton label={`Remove ${edit.name}`} onClick={() => { if (confirm(`Remove ${edit.name}? Their reports move up to the board.`)) act(async () => { await api(`/company/agents/${edit.id}`, { method: "DELETE" }); setEdit(null); }); }}><Trash2 size={16} /></IconButton>}
          {editing && (editing.status === "paused"
            ? <Button icon={<Play size={14} />} onClick={() => setStatus(editing, "active")}>Resume</Button>
            : <Button icon={<Pause size={14} />} onClick={() => setStatus(editing, "paused")}>Pause</Button>)}
          <span className="ag-bar-end"><Button type="submit" form="co-agent-form" variant="primary">{edit.id ? "Save" : "Hire"}</Button></span>
        </div>}>
        {edit && (
          <form id="co-agent-form" className="ag-form" onSubmit={saveAgent}>
            <div className="ag-two">
              <Input label="Name" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <Input label="Role" placeholder="CEO, CTO, Engineer…" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </div>
            <Select label="Reports to" value={edit.reports_to ?? 0} onChange={(e) => setEdit({ ...edit, reports_to: Number(e.target.value) || null })}>
              <option value={0}>The board (you)</option>
              {data.agents.filter((a) => a.id !== edit.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <div className="ui-field"><span className="ui-field-label">Model</span><ModelSelect value={edit.model} onChange={(v) => setEdit({ ...edit, model: v })} models={models} /></div>
            <Textarea label="Instructions" rows={4} value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} placeholder="Responsibilities, standards, what to escalate to the board" />
            <div className="ag-two">
              <Input label="Monthly budget (USD)" type="number" min={0} step={0.5} value={edit.monthly_budget_cents / 100} onChange={(e) => setEdit({ ...edit, monthly_budget_cents: Math.round(Number(e.target.value) * 100) })} />
              <Input label="Monthly token limit" hint="0 means no limit" type="number" min={0} step={10000} value={edit.monthly_token_limit} onChange={(e) => setEdit({ ...edit, monthly_token_limit: Number(e.target.value) })} />
            </div>
            <p className="ag-note">The agent is paused automatically when it reaches either limit. Checks run before each model call, so a limit can be passed by at most one call.</p>
            {editing?.paused_reason && <p className="ag-err">{editing.paused_reason}</p>}
          </form>
        )}
      </Sheet>
    </Page>
  );
}
