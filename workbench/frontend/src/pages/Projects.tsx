// feat/v02-core: Projects with memory. One place per job, client, matter or course.
import { Archive, ArrowLeft, Bell, BookMarked, CalendarClock, Check, FileText, FolderKanban, Globe2, Link2, Mail, MessageSquare, NotebookPen, Plus, Trash2, UserRound, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, Card, Chip, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Select, Textarea } from "../ui";
import { relTime, useToast } from "../util";
import { isUpgrade, Project, ProjectList, UpgradeCard } from "../v02/shared";
import "../v02/v02.css";
import { plainError, Split } from "./day/parts";

type Item = { id: number; kind: string; ref: string; title: string; body: string; due: string | null; done: boolean; auto: boolean; reason: string; overdue?: boolean; created_at: string };
type Detail = Project & { kind_label: string; active: boolean; items: Record<string, Item[]>; facts: { id: number; content: string }[];
  suggestions: { kind: string; ref: string; title: string; matched: string[] }[] };

const ADD: { kind: string; label: string; icon: typeof Plus; title?: string; body?: string; due?: boolean }[] = [
  { kind: "note", label: "Note", icon: NotebookPen, body: "What to remember, e.g. gate code, scope, marking rubric" },
  { kind: "person", label: "Person", icon: UserRound, title: "Name", body: "Role or contact (optional)" },
  { kind: "deadline", label: "Deadline", icon: CalendarClock, title: "What is due", due: true },
  { kind: "link", label: "Link", icon: Link2, title: "Web address" },
];
const SECTIONS: { kind: string; label: string; icon: typeof Plus }[] = [
  { kind: "deadline", label: "Deadlines", icon: CalendarClock }, { kind: "update", label: "What changed", icon: Bell },
  { kind: "mail", label: "Mail", icon: Mail }, { kind: "person", label: "People", icon: UserRound },
  { kind: "note", label: "Notes", icon: NotebookPen }, { kind: "file", label: "Files", icon: FileText },
  { kind: "site", label: "Sites", icon: Globe2 }, { kind: "chat", label: "Chats", icon: MessageSquare }, { kind: "link", label: "Links", icon: Link2 },
];

export default function Projects() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [list, setList] = useState<ProjectList | null>(null);
  const [problem, setProblem] = useState("");
  const [sel, setSel] = useState<Detail | null>(null);
  const [opening, setOpening] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "job", description: "", keywords: "" });
  const [upgrade, setUpgrade] = useState(false);
  const [adding, setAdding] = useState<string>("");
  const [draft, setDraft] = useState({ title: "", body: "", due: "" });
  const [archived, setArchived] = useState(false);

  const load = useCallback(async () => {
    const r = await api<ProjectList>(`/projects${archived ? "?archived=true" : ""}`);
    setList(r);
    return r;
  }, [archived]);
  const open = useCallback(async (pid: number) => setSel(await api<Detail>(`/projects/${pid}`)), []);
  const first = useCallback(() => {
    setProblem("");
    load().then((r) => {
      const pid = id ? Number(id) : r.active_id ?? r.projects[0]?.id;
      if (pid) { setOpening(true); open(pid).catch(toast.err).finally(() => setOpening(false)); } else setSel(null);
    }).catch((e) => setProblem(plainError(e, "Your projects did not load.")));
  }, [id, load, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(first, [first]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast.ok(ok); await load(); if (sel) await open(sel.id).catch(() => setSel(null)); }
    catch (e) { if (isUpgrade(e)) setUpgrade(true); else toast.err(e); }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api<Detail>("/projects", { body: form });
      setCreating(false); setForm({ name: "", kind: "job", description: "", keywords: "" });
      await load(); navigate(`/projects/${p.id}`);
    } catch (err) { if (isUpgrade(err)) { setCreating(false); setUpgrade(true); } else toast.err(err); }
  };
  const startCreate = () => (list && !list.limit.can_add ? setUpgrade(true) : setCreating(true));

  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!sel) return;
    const body = adding === "link" ? { kind: "link", ref: draft.title, title: draft.title } : { kind: adding, title: draft.title, body: draft.body, due: draft.due || null };
    await act(() => api(`/projects/${sel.id}/items`, { body }));
    setAdding(""); setDraft({ title: "", body: "", due: "" });
  };

  const spec = ADD.find((a) => a.kind === adding);
  const projects = list?.projects ?? [];
  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };

  const listPane = (
    <>
      <div className="day-split-scroll">
        {list === null && !problem && <Loading rows={4} label="Loading projects" />}
        {problem && <div className="day-pad"><ErrorState title="Projects did not load" line={problem} onRetry={first} /></div>}
        {list !== null && !problem && !projects.length && (
          <EmptyState icon={<FolderKanban size={22} />} title={archived ? "Nothing archived" : "No projects yet"}
            line={archived ? undefined : "Start one for the job, client or course you are on now."}
            action={archived ? <Button size="sm" onClick={() => setArchived(false)}>Show open projects</Button> : <Button size="sm" icon={<Plus size={14} />} onClick={startCreate}>New project</Button>} />
        )}
        {projects.length > 0 && (
          <List label="Projects">
            {projects.map((p) => (
              <Row key={p.id} active={sel?.id === p.id} onClick={() => navigate(`/projects/${p.id}`)}
                title={<>{p.name}{list?.active_id === p.id && <Badge tone="live" className="day-title-badge">Active</Badge>}</>}
                meta={p.status === "archived" ? "Archived" : p.next_deadline ? `Next: ${p.next_deadline.title} · ${p.next_deadline.due}` : `${Object.values(p.counts ?? {}).reduce((a, b) => a + b, 0)} things`} />
            ))}
          </List>
        )}
      </div>
      <div className="day-split-foot">
        <Button variant="ghost" size="sm" onClick={() => setArchived(!archived)}>{archived ? "Hide archived" : "Show archived"}</Button>
        {list && !list.limit.unlimited && <p className="day-hint">{list.limit.active > list.limit.free_limit
          ? `Free plan: ${list.limit.active} projects open, the free plan keeps ${list.limit.free_limit}. Archive ${list.limit.active - list.limit.free_limit} to start a new one, or upgrade.`
          : `Free plan: ${list.limit.active} of ${list.limit.free_limit} project in use.`}</p>}
      </div>
    </>
  );

  const mainPane = !sel ? (
    opening ? <div className="day-pad"><Loading rows={4} label="Opening the project" /></div>
      : <EmptyState icon={<FolderKanban size={24} />} title="Pick a project, or start one" action={<Button size="sm" icon={<Plus size={14} />} onClick={startCreate}>New project</Button>} />
  ) : (
    <div className="day-detail">
      <header className="day-detail-head">
        <IconButton className="day-phone-only" label="Back to the list" size="sm" onClick={() => { setSel(null); navigate("/projects"); }}><ArrowLeft size={16} /></IconButton>
        <div className="day-detail-titles">
          <p className="day-kicker">{sel.kind_label}</p>
          <h2 className="day-detail-title">{sel.name}</h2>
          {sel.description && <p className="day-detail-meta">{sel.description}</p>}
          {sel.keywords && <p className="day-hint">Recognised by: {sel.keywords}</p>}
        </div>
      </header>
      <div className="day-actions">
        {sel.status === "active" && (sel.active
          ? <Button size="sm" icon={<X size={14} />} onClick={() => void act(() => api("/projects/active", { method: "PUT", body: { project_id: null } }), "Closed. New chats start without a project.")}>Close</Button>
          : <Button variant="primary" size="sm" icon={<Check size={14} />} onClick={() => void act(() => api("/projects/active", { method: "PUT", body: { project_id: sel.id } }), "New chats will use this project")}>Work on this</Button>)}
        <Button size="sm" icon={<MessageSquare size={14} />} onClick={() => navigate("/assistant", { state: { draft: `About ${sel.name}: ` } })}>Ask about it</Button>
        <span className="day-grow" />
        <IconButton label={sel.status === "archived" ? "Restore project" : "Archive project"} size="sm"
          onClick={() => void act(() => api(`/projects/${sel.id}`, { method: "PUT", body: { status: sel.status === "archived" ? "active" : "archived" } }), sel.status === "archived" ? "Restored" : "Archived")}><Archive size={14} /></IconButton>
        <IconButton label="Delete project" size="sm" onClick={() => confirm(`Delete ${sel.name}? Its files, chats and sites stay in the app.`) && void act(() => api(`/projects/${sel.id}`, { method: "DELETE" }), "Deleted").then(() => navigate("/projects"))}><Trash2 size={14} /></IconButton>
      </div>

      <div className="day-chips" role="group" aria-label="Add to this project">
        {ADD.map((a) => <Chip key={a.kind} active={adding === a.kind} icon={<a.icon size={14} />} onClick={() => setAdding(adding === a.kind ? "" : a.kind)}>{a.label}</Chip>)}
      </div>
      {spec && (
        <Card padding="sm">
          <form className="day-form" onSubmit={addItem}>
            {spec.title && <Input autoFocus aria-label={spec.title} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={spec.title} />}
            {spec.body && <Textarea rows={2} aria-label={spec.label} autoFocus={!spec.title} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder={spec.body} />}
            {spec.due && <Input type="date" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} aria-label="Due date" />}
            <div className="day-actions"><Button type="submit" variant="primary" size="sm" disabled={!(draft.title.trim() || draft.body.trim())}>Add</Button><Button variant="ghost" size="sm" onClick={() => setAdding("")}>Cancel</Button></div>
          </form>
        </Card>
      )}

      {sel.suggestions.length > 0 && (
        <Section title="Might belong here">
          <List label="Might belong here">
            {sel.suggestions.map((s) => (
              <Row key={s.kind + s.ref} title={s.title} meta={`${s.kind} · mentions ${s.matched.join(", ")}`}
                actions={<>
                  <Button size="sm" icon={<Plus size={13} />} onClick={() => void act(() => api(`/projects/${sel.id}/items`, { body: { kind: s.kind, ref: s.ref } }))}>Add</Button>
                  <IconButton label="Not this project" size="sm" onClick={() => void act(() => api(`/projects/${sel.id}/dismiss`, { body: { kind: s.kind, ref: s.ref } }))}><X size={14} /></IconButton>
                </>} />
            ))}
          </List>
        </Section>
      )}

      {SECTIONS.filter((s) => sel.items[s.kind]?.length).map((s) => (
        <Section key={s.kind} title={s.label}>
          <ul className="day-items" aria-label={s.label}>
            {sel.items[s.kind].map((it) => (
              <li key={it.id} className={`day-item${it.overdue ? " is-late" : ""}${it.done ? " is-done" : ""}`}>
                {it.kind === "deadline" && <input type="checkbox" className="day-item-check" checked={it.done} aria-label={`Done: ${it.title}`} onChange={() => void act(() => api(`/projects/items/${it.id}`, { method: "PUT", body: { done: !it.done } }))} />}
                <div className="day-item-text">
                  {it.kind === "chat" ? <a href={`/assistant/${it.ref}`} onClick={go(`/assistant/${it.ref}`)}>{it.title}</a>
                    : it.kind === "file" ? <a href="/files" onClick={go("/files")}>{it.title}</a>
                    : it.kind === "site" ? <a href="/sites" onClick={go("/sites")}>{it.title}</a>
                    : it.kind === "link" ? <a href={it.ref} target="_blank" rel="noreferrer noopener">{it.title}</a>
                    : it.kind === "mail" ? <a href="/mail" onClick={go("/mail")}>{it.title}</a>
                    : it.kind === "note" ? <span className="day-note">{it.body}</span> : <span>{it.title}</span>}
                  {(it.kind === "person" || it.kind === "mail") && it.body && <span className="day-hint"> · {it.body}</span>}
                </div>
                {it.due && <span className={it.overdue ? "day-danger-text day-when" : "day-when"}>{it.overdue ? "Overdue · " : ""}{it.due}</span>}
                <IconButton label="Take out of project" size="sm" onClick={() => void act(() => api(`/projects/items/${it.id}`, { method: "DELETE" }))}><X size={14} /></IconButton>
              </li>
            ))}
          </ul>
        </Section>
      ))}
      {!SECTIONS.some((s) => sel.items[s.kind]?.length) && <EmptyState className="day-empty-sm" title="Nothing here yet" line="Add a person, a deadline or a note." action={<Button size="sm" icon={<NotebookPen size={14} />} onClick={() => setAdding("note")}>Add a note</Button>} />}

      {sel.facts.length > 0 && (
        <Section title="What I know that relates" actions={<Link className="day-link" to="/about-you"><BookMarked size={14} aria-hidden="true" /> Edit in What I know</Link>}>
          <List label="What I know that relates">{sel.facts.map((f) => <Row key={f.id} title={<span className="day-wrap">{f.content}</span>} />)}</List>
        </Section>
      )}
      {sel.last_used_at && <p className="day-hint">Last worked on {relTime(sel.last_used_at)}</p>}
    </div>
  );

  return (
    <Page title="Projects" description="One place for a job, a client, a case or a course." wide className="day-page"
      actions={<Button variant="primary" icon={<Plus size={15} />} onClick={startCreate}>New project</Button>}>
      {upgrade && <UpgradeCard feature="projects_unlimited" onClose={() => setUpgrade(false)} />}
      {creating && (
        <Card as="section" className="day-gap" aria-label="New project">
          <form className="day-form" onSubmit={create}>
            <h2 className="day-detail-title">New project</h2>
            <Input label="Name" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. 12 Smith St renovation, Acme Pty Ltd, BIOL101" />
            <Select label="What kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(list?.kinds ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Input label="Words that mean this project (optional)" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="job number, client name, case number, course code" />
            <Textarea label="About it (optional)" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <div className="day-actions"><Button type="submit" variant="primary" disabled={form.name.trim().length < 2}>Create</Button><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></div>
          </form>
        </Card>
      )}
      {list !== null && !problem && !projects.length && !archived && !sel
        ? <EmptyState icon={<FolderKanban size={24} />} title="No projects yet" line="Start one for the job, client or course you are on now."
            action={<Button icon={<Plus size={14} />} onClick={startCreate}>New project</Button>} />
        : <Split label="Projects" picked={!!sel && !!id} list={listPane} main={mainPane} />}
    </Page>
  );
}
