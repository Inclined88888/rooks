import { Check, CheckSquare, ChevronDown, Flag, ListTree, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, Task } from "../api";
import { loadCached, peekCached, putCached } from "../lib/cache";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading, Page, Section, Select, Tabs, Textarea } from "../ui";
import { todayISO, useModels, useToast } from "../util";
import { ModelPicker, plainError } from "./day/parts";

const PRIO = ["None", "Low", "Medium", "High"];
/** design 0012: tasks that live in Planner or To Do too. A change to one waits for your yes in Needs you. */
const ORIGIN: Record<string, string> = { planner: "Planner", todo: "To Do" };

function TaskRow({ task, onChange, onDelete }: { task: Task; onChange: (t: Task) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(task);
  const toast = useToast();
  useEffect(() => setDraft(task), [task]);
  const today = todayISO();
  const done = task.status === "done";

  const where = task.origin ? ORIGIN[task.origin] : "";
  /** A task in Planner or To Do changes there only after your yes in Needs you, like everything Rooks sends out. */
  const ask = async (args: { done?: boolean; due?: string; title?: string }) => {
    try {
      const r = await api<{ title: string; already_asked: boolean }>("/work/hold", { body: { tool: "work_task_update", args: { task: String(task.id), ...args } } });
      toast.ok(r.already_asked ? "That is already waiting for your OK in Needs you" : `Waiting for your OK in Needs you: ${r.title}`);
    } catch (e) { toast.err(e); }
  };
  const patch = async (body: Partial<Task> & { clear_due?: boolean }) => {
    if (where && body.status) { void ask({ done: body.status === "done" }); return; }
    try { onChange(await api<Task>(`/tasks/${task.id}`, { method: "PATCH", body })); } catch (e) { toast.err(e); }
  };
  const save = () => where
    ? ask({ ...(draft.title !== task.title ? { title: draft.title } : {}), ...(draft.due && draft.due !== task.due ? { due: draft.due } : {}) })
    : patch({ title: draft.title, notes: draft.notes, priority: draft.priority, project: draft.project, ...(draft.due ? { due: draft.due } : { clear_due: true }) });
  const late = !done && !!task.due && task.due < today;

  return (
    <li className={`day-task${done ? " is-done" : ""}`}>
      <div className="day-task-line">
        <button type="button" className={`day-tick${done ? " is-done" : ""}`} onClick={() => void patch({ status: done ? "todo" : "done" })}
          aria-pressed={done} aria-label={done ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`}>
          {done && <Check size={12} strokeWidth={3} />}
        </button>
        <button type="button" className="day-task-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="day-task-title">{task.title}</span>
          {task.notes && !open && <span className="day-task-notes">{task.notes}</span>}
        </button>
        <span className="day-task-tags">
          {task.priority > 0 && <span className={`day-prio is-${task.priority}`} title={`${PRIO[task.priority]} priority`}><Flag size={13} aria-hidden="true" /><span className="sr-only">{PRIO[task.priority]} priority</span></span>}
          {task.project && <Badge>{task.project}</Badge>}
          {where && <Badge title={`Also in ${where}`}>{where}</Badge>}
          {task.due && <Badge tone={late ? "danger" : task.due === today && !done ? "warn" : "neutral"}>{task.due === today ? "Today" : task.due}</Badge>}
          <ChevronDown size={14} aria-hidden="true" className={`day-task-chev${open ? " is-open" : ""}`} />
        </span>
      </div>
      {open && (
        <div className="day-task-edit">
          <Input label="Task" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <Textarea label="Notes" rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          <div className="day-form-grid">
            <Input label="Due" type="date" value={draft.due ?? ""} onChange={(e) => setDraft({ ...draft, due: e.target.value || null })} />
            <Select label="Priority" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>
              {PRIO.map((p, i) => <option key={p} value={i}>{p}</option>)}
            </Select>
            <Input label="Project" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} />
            <Select label="Status" value={task.status} onChange={(e) => void patch({ status: e.target.value as Task["status"] })}>
              <option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option>
            </Select>
          </div>
          {where && <p className="day-hint">This task is in {where}. A change there waits for your yes in Needs you.</p>}
          <div className="day-form-foot">
            {!where && <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={onDelete}>Delete</Button>}
            <Button variant="primary" size="sm" onClick={async () => { await save(); setOpen(false); }}>Save</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function Tasks() {
  // The last list shows at once on a return visit and is asked again in the background (lib/cache.ts).
  const [tasks, setTasksNow] = useState<Task[]>(() => peekCached<Task[]>("tasks") ?? []);
  const setTasks = (next: Task[] | ((l: Task[]) => Task[])) => setTasksNow((cur) => {
    const v = typeof next === "function" ? next(cur) : next;
    putCached("tasks", v);
    return v;
  });
  const [loaded, setLoaded] = useState(() => peekCached<Task[]>("tasks") !== undefined);
  const [problem, setProblem] = useState("");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [project, setProject] = useState("");
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const { models } = useModels();
  const toast = useToast();

  const load = () => {
    setProblem("");
    // Planner and To Do join the list when the work account's Tasks switch is on (design 0012); a failure leaves the rest
    api<{ planner: number; todo: number }>("/work/tasks/sync", { method: "POST" })
      .then(() => api<Task[]>("/tasks").then(setTasks)).catch(() => undefined);
    return loadCached("tasks", () => api<Task[]>("/tasks")).then(setTasks).catch((e) => setProblem(plainError(e, "Your tasks did not load."))).finally(() => setLoaded(true));
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const t = await api<Task>("/tasks", { body: { title, due: due || null, project } });
      setTasks((l) => [t, ...l]);
      setTitle("");
      setDue("");
    } catch (err) {
      toast.err(err);
    }
  };

  const breakdown = async () => {
    setBusy(true);
    try {
      const created = await api<Task[]>("/tasks/breakdown", { body: { goal, project, model: model || null } });
      setTasks((l) => [...created, ...l]);
      setGoal("");
      toast.ok(`Added ${created.length} tasks`);
    } catch (err) {
      toast.err(err);
    } finally {
      setBusy(false);
    }
  };

  const projects = useMemo(() => [...new Set(tasks.map((t) => t.project).filter(Boolean))].sort(), [tasks]);
  const today = todayISO();
  const visible = tasks.filter((t) => (filter === "all" || (filter === "done" ? t.status === "done" : t.status !== "done")) && (!project || t.project === project));
  const groups: [string, Task[]][] = filter === "done"
    ? [["Completed", visible]]
    : [
        ["Overdue", visible.filter((t) => t.status !== "done" && t.due && t.due < today)],
        ["Today", visible.filter((t) => t.status !== "done" && t.due === today)],
        ["Upcoming", visible.filter((t) => t.status !== "done" && t.due && t.due > today)],
        ["No date", visible.filter((t) => t.status !== "done" && !t.due)],
        ...(filter === "all" ? [["Completed", visible.filter((t) => t.status === "done")] as [string, Task[]]] : []),
      ];

  const update = (t: Task) => setTasks((l) => l.map((x) => (x.id === t.id ? t : x)));
  const remove = async (id: number) => {
    try {
      await api(`/tasks/${id}`, { method: "DELETE" });
      setTasks((l) => l.filter((x) => x.id !== id));
    } catch (e) { toast.err(e); }
  };

  return (
    <Page title="Tasks" description="Chat can read, add and complete these." className="day-page"
      actions={(
        <>
          <Tabs label="Show" value={filter} onChange={(f) => setFilter(f as typeof filter)} items={[{ id: "open", label: "Open" }, { id: "done", label: "Done" }, { id: "all", label: "All" }]} />
          {projects.length > 0 && (
            <Select aria-label="Project" className="day-project-filter" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p}>{p}</option>)}
            </Select>
          )}
        </>
      )}>
      <Card className="day-add">
        <form className="day-add-row" onSubmit={add}>
          <Input className="day-grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task and press Enter" aria-label="New task" />
          <Input type="date" className="day-date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <Button type="submit" variant="primary" icon={<Plus size={16} />} disabled={!title.trim()}>Add</Button>
        </form>
        <div className="day-add-row day-add-ai">
          <ListTree size={16} aria-hidden="true" className="day-muted-icon" />
          <Input className="day-grow" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Break a goal into tasks, e.g. plan a team offsite in March" aria-label="A goal to break into tasks" />
          <ModelPicker value={model} onChange={setModel} models={models} />
          <Button disabled={goal.trim().length < 3} busy={busy} onClick={breakdown}>{busy ? "Breaking it down…" : "Break down"}</Button>
        </div>
      </Card>

      {!loaded && <Loading rows={5} label="Loading tasks" />}
      {loaded && problem && <ErrorState title="Tasks did not load" line={problem} onRetry={() => void load()} />}
      {loaded && !problem && visible.length === 0 && (
        <EmptyState icon={<CheckSquare size={24} />} title={filter === "done" ? "Nothing completed yet" : "All clear"}
          line={filter === "done" ? "Tasks you finish show up here." : "Add a task above, or ask in Chat."}
          action={filter === "done" ? <Button size="sm" onClick={() => setFilter("open")}>Show open tasks</Button> : undefined} />
      )}
      {groups.filter(([, l]) => l.length).map(([name, list]) => (
        <Section key={name} title={name} actions={<span className={`day-count${name === "Overdue" ? " day-danger-text" : ""}`}>{list.length}</span>} className="day-task-group">
          <ul className="day-tasks" aria-label={name}>{list.map((t) => <TaskRow key={t.id} task={t} onChange={update} onDelete={() => void remove(t.id)} />)}</ul>
        </Section>
      ))}
    </Page>
  );
}
