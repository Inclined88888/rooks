// Memory: the one page over the one memory store (docs/architecture.md, g.2). What I know (add, correct, explain, pin,
// forget, forget everything), people, project knowledge, decisions, tidy-up, your data, and the learning switches that
// used to live on About you. Chat, the terminal and this page read and write the same rows (/api/knowledge/memories).
// Premium pass (package C): built on the primitives, with a loading, an empty and an error state on every tab.
import { ArrowLeft, BookMarked, Check, FolderKanban, HelpCircle, Lock, Pencil, Pin, PinOff, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { relTime, useToast } from "../util";
import { Badge, Button, Card, EmptyState, IconButton, Input, List, Page, Row, Section, Select, Tabs, Textarea } from "../ui";
import { SettingRow, SettingsGroup, Switch } from "../pages/settings/index";
import { Gate, useLoad } from "../pages/agents/kit";
import { FiledChip } from "./FiledChip";
import GraphWalk from "./GraphWalk";
import { YourData } from "./YourData";
import { Conflict, Entity, EntityDetail, Filing, Mem, SCOPE_LABEL, sourceLine, TIER_LABEL, Tidy, Why } from "./types";
import "./memory.css";

type Tab = "people" | "projects" | "memories" | "decide" | "tidy" | "learning" | "data";
const TABS: { id: Tab; label: string }[] = [
  { id: "memories", label: "What I know" }, { id: "people", label: "People" }, { id: "projects", label: "Projects" },
  { id: "decide", label: "Needs your call" }, { id: "tidy", label: "Tidy up" }, { id: "learning", label: "Learning" }, { id: "data", label: "Your data" },
];

export default function Knowledge() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "memories";
  const entityId = params.get("entity");
  const tidy = useLoad(() => api<Tidy>("/knowledge/tidy"), []);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const go = (t: string) => setParams({ tab: t });
  const counts: Partial<Record<Tab, number>> = { decide: tidy.data?.conflicts.length, tidy: tidy.data?.duplicates.length };

  return (
    <Page className="ag-page kn" title="What I know" kicker="Memory"
      description="Everything I remember, in chat and in the terminal: who it's about, where it came from and who can see it. Correct or forget anything. Sensitive things never leave this computer."
      actions={<Button icon={<Plus size={14} />} onClick={() => { setAdding(true); if (tab !== "memories") go("memories"); }}>Tell me something</Button>}>
      {entityId ? <EntityPage id={Number(entityId)} onBack={() => setParams({ tab })} /> : <>
        <div className="kn-tabs">
          <Tabs label="Memory" items={TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] || undefined }))} value={tab} onChange={go} />
        </div>
        {tab === "memories" && <Memories toast={toast} adding={adding} onAdded={() => setAdding(false)} />}
        {tab === "people" && <Entities type="person" icon={<UserRound size={20} />} empty="I add people as they come up in chats, mail, meetings and projects." />}
        {tab === "projects" && <Entities type="project" icon={<FolderKanban size={20} />} empty="Make one on the Projects page and I'll gather what belongs to it." />}
        {tab === "decide" && <Gate state={tidy}>{(t) => <Decide items={t.conflicts} onDone={tidy.reload} />}</Gate>}
        {tab === "tidy" && <Gate state={tidy}>{(t) => <TidyUp tidy={t} onDone={tidy.reload} toast={toast} />}</Gate>}
        {tab === "learning" && <Learning toast={toast} />}
        {tab === "data" && <YourData toast={toast} />}
      </>}
    </Page>
  );
}

const KINDS: { tier: string; label: string }[] = [{ tier: "profile", label: "About you and your work" }, { tier: "procedural", label: "How you like things done" }];

function Memories({ toast, adding, onAdded }: { toast: ReturnType<typeof useToast>; adding: boolean; onAdded: () => void }) {
  const mems = useLoad(() => api<Mem[]>("/knowledge/memories"), []);
  const [q, setQ] = useState("");
  const [why, setWhy] = useState<Record<number, Why>>({});
  const [draft, setDraft] = useState({ content: "", tier: "profile" });
  const [editing, setEditing] = useState<{ id: number; content: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const shown = useMemo(() => (mems.data ?? []).filter((m) => !q.trim() || m.content.toLowerCase().includes(q.toLowerCase())), [mems.data, q]);
  const groups = useMemo(() => Object.keys(TIER_LABEL).map((t) => [t, shown.filter((m) => m.tier === t)] as const).filter(([, l]) => l.length), [shown]);
  const patch = async (m: Mem, body: Partial<Mem>) => { try { await api(`/knowledge/memories/${m.id}`, { method: "PATCH", body }); mems.reload(); } catch (e) { toast.err(e); } };
  const forget = async (m: Mem) => { try { await api(`/knowledge/memories/${m.id}`, { method: "DELETE" }); toast.ok("Forgotten"); mems.reload(); } catch (e) { toast.err(e); } };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/knowledge/memories", { method: "POST", body: { content: draft.content, tier: draft.tier, pinned: draft.tier === "profile" } });
      setDraft({ content: "", tier: draft.tier }); onAdded(); toast.ok("Saved"); mems.reload();
    } catch (e2) { toast.err(e2); }
  };
  const save = async () => {
    if (!editing) return;
    try { await api(`/knowledge/memories/${editing.id}`, { method: "PATCH", body: { content: editing.content } }); setEditing(null); toast.ok("Corrected"); mems.reload(); } catch (e) { toast.err(e); }
  };
  const forgetAll = async () => {
    try { await api("/knowledge/memories/forget-all", { body: {} }); setConfirmAll(false); toast.ok("Everything I knew about you is gone"); mems.reload(); } catch (e) { toast.err(e); }
  };
  const explain = async (m: Mem) => {
    if (why[m.id]) { const n = { ...why }; delete n[m.id]; setWhy(n); return; }
    try { setWhy({ ...why, [m.id]: await api<Why>(`/knowledge/memories/${m.id}/why`) }); } catch (e) { toast.err(e); }
  };
  const form = adding && (
    <Section title="Something I should know">
      <form className="ag-stack" onSubmit={add}>
        <Textarea rows={2} autoFocus aria-label="Something I should know" value={draft.content} placeholder="For example: I manage the service desk team, and I like short answers"
          onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
        <div className="ag-bar">
          <Select className="kn-source" aria-label="Kind" value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value })}>
            {KINDS.map((k) => <option key={k.tier} value={k.tier}>{k.label}</option>)}
          </Select>
          <Button type="submit" variant="primary" disabled={draft.content.trim().length < 3}>Save</Button>
          <Button variant="ghost" onClick={onAdded}>Cancel</Button>
        </div>
      </form>
    </Section>
  );
  return (
    <Gate state={mems} rows={5}>{(list) => !list.length
      ? <div className="ag-stack">{form}<EmptyState icon={<BookMarked size={20} />} title="Nothing remembered yet" line="Tell me something, or just chat. What I learn shows here, with where it came from." /></div>
      : <div className="ag-stack">
        {form}
        <div className="kn-search"><Search size={15} aria-hidden="true" /><Input aria-label="Find a memory" placeholder="Find a memory" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {!groups.length && <p className="ag-note">Nothing matches “{q}”.</p>}
        {groups.map(([tier, items]) => (
          <Section key={tier} title={TIER_LABEL[tier]}>
            <List className="ag-list" label={TIER_LABEL[tier]}>
              {items.map((m) => (
                <Row key={m.id}
                  title={editing?.id === m.id
                    ? <span className="kn-edit">
                      <Input autoFocus aria-label="Correct this" value={editing.content} onChange={(e) => setEditing({ id: m.id, content: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(null); }} />
                      <IconButton size="sm" label="Save" onClick={save}><Check size={14} /></IconButton>
                      <IconButton size="sm" label="Cancel" onClick={() => setEditing(null)}><X size={14} /></IconButton>
                    </span>
                    : m.content}
                  meta={<span className="kn-meta">
                    {m.pinned && <Badge>Always in mind</Badge>}
                    {m.privacy === "sensitive" && <Badge tone="warn"><Lock size={10} aria-hidden="true" /> Sensitive, never sent to online models</Badge>}
                    <Badge>{SCOPE_LABEL(m.scope)}</Badge>
                    <span>{sourceLine(m.source_kind)} {relTime(m.observed_at)}</span>
                    {why[m.id] && <span className="kn-why">{why[m.id].summary}{why[m.id].replaced.length ? ` It replaced: “${why[m.id].replaced[0].content}”.` : ""}</span>}
                  </span>}
                  actions={<>
                    <IconButton size="sm" label="Why do you know this?" active={!!why[m.id]} onClick={() => explain(m)}><HelpCircle size={15} /></IconButton>
                    <IconButton size="sm" label="Correct this" onClick={() => setEditing({ id: m.id, content: m.content })}><Pencil size={15} /></IconButton>
                    <IconButton size="sm" label={m.pinned ? "Only when it matters" : "Always keep in mind"} onClick={() => patch(m, { pinned: !m.pinned })}>{m.pinned ? <PinOff size={15} /> : <Pin size={15} />}</IconButton>
                    <IconButton size="sm" label={m.privacy === "sensitive" ? "Mark as normal" : "Mark sensitive"} onClick={() => patch(m, { privacy: m.privacy === "sensitive" ? "normal" : "sensitive" })}><Lock size={15} /></IconButton>
                    <IconButton size="sm" label="Forget this" onClick={() => forget(m)}><Trash2 size={15} /></IconButton>
                  </>} />
              ))}
            </List>
          </Section>
        ))}
        <div className="ag-bar">
          {confirmAll ? <>
            <span className="ag-note">Forget everything I know about you and your work? This can't be undone.</span>
            <Button variant="danger" size="sm" onClick={forgetAll}>Yes, forget it all</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmAll(false)}>Keep</Button>
          </> : <Button variant="ghost" size="sm" onClick={() => setConfirmAll(true)}>Forget everything</Button>}
        </div>
      </div>}
    </Gate>
  );
}

type LearnSettings = { memory: boolean; memory_in_chat: boolean; notice_patterns: boolean; suggest: boolean };
type Work = { kind: string; label: string; times: number };
type Lesson = { id: number; lesson: string; created_at: string };
const SWITCHES: { key: keyof LearnSettings; label: string; hint: string }[] = [
  { key: "memory", label: "Learn about me as we work", hint: "From chats, the terminal, files, tasks and things you show me. Kept on this computer, encrypted." },
  { key: "memory_in_chat", label: "Use what I know in answers", hint: "Off means I answer without these notes, even though they stay saved." },
  { key: "notice_patterns", label: "Notice my routines", hint: "Spot work you repeat, like a Monday report." },
  { key: "suggest", label: "Offer to take things over", hint: "Suggest one-click routines. Nothing goes out without your OK." },
];

/** The learning switches, the work I've seen and what I learned from your changes (these were on About you). */
function Learning({ toast }: { toast: ReturnType<typeof useToast> }) {
  const settings = useLoad(() => api<LearnSettings>("/learn/settings"), []);
  const work = useLoad(() => api<Work[]>("/learn/work"), []);
  const lessons = useLoad(() => api<Lesson[]>("/learn/lessons"), []);
  const flip = async (cur: LearnSettings, key: keyof LearnSettings) => {
    try { await api("/learn/settings", { method: "PUT", body: { [key]: !cur[key] } }); settings.reload(); } catch (e) { toast.err(e); }
  };
  return (
    <div className="ag-stack">
      <Section title="Learning">
        <Gate state={settings} rows={4}>{(cur) => (
          <SettingsGroup label="Learning">
            {SWITCHES.map((s) => (
              <SettingRow key={s.key} label={s.label} help={s.hint}>
                <Switch checked={!!cur[s.key]} onChange={() => flip(cur, s.key)} label={s.label} />
              </SettingRow>
            ))}
          </SettingsGroup>
        )}</Gate>
      </Section>
      <Section title="The work I've seen">
        <Gate state={work} rows={2}>{(list) => list.length
          ? <List className="ag-list" label="The work I've seen">{list.slice(0, 8).map((w) => (
            <Row key={w.kind} title={w.label.charAt(0).toUpperCase() + w.label.slice(1)} meta={`${w.times} time${w.times === 1 ? "" : "s"}`} />
          ))}</List>
          : <p className="ag-note">Nothing yet. As we work I'll notice what you do often.</p>}</Gate>
      </Section>
      <Section title="Learned from your changes">
        <Gate state={lessons} rows={2}>{(list) => list.length
          ? <List className="ag-list" label="Learned from your changes">{list.slice(0, 8).map((l) => <Row key={l.id} title={l.lesson} meta={relTime(l.created_at)} />)}</List>
          : <p className="ag-note">When you edit something I wrote, I'll note what to do differently here.</p>}</Gate>
      </Section>
    </div>
  );
}

function Entities({ type, icon, empty }: { type: string; icon: React.ReactNode; empty: string }) {
  const list = useLoad(() => api<Entity[]>(`/knowledge/entities?type=${type}`), [type]);
  const [, setParams] = useSearchParams();
  return (
    <Gate state={list} rows={4}>{(items) => !items.length
      ? <EmptyState icon={icon} title={type === "person" ? "No people yet" : "No projects yet"} line={empty} />
      : <List className="ag-list" label={type === "person" ? "People" : "Projects"}>
        {items.map((e) => (
          <Row key={e.id} leading={icon} title={e.name} onClick={() => setParams({ entity: String(e.id), tab: type === "person" ? "people" : "projects" })}
            meta={[e.attrs.role, e.attrs.company, e.attrs.email, e.attrs.kind, e.attrs.status].filter(Boolean).join(" · ") || (type === "person" ? "Person" : "Project")} />
        ))}
      </List>}
    </Gate>
  );
}

const LINK_LABEL: Record<string, string> = { person: "People", project: "Projects", document: "Files", task: "Tasks", event: "Meetings and events", site: "Sites", thread: "Chats", organisation: "Organisations", place: "Places" };

function EntityPage({ id, onBack }: { id: number; onBack: () => void }) {
  const detail = useLoad(() => api<EntityDetail>(`/knowledge/entities/${id}`), [id]);
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  return (
    <div className="ag-stack">
      <div><Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={onBack}>Back</Button></div>
      <Gate state={detail} rows={4} title="That did not open">{(e) => {
        const byType = e.links.reduce<Record<string, Entity[]>>((a, l) => ((a[l.type] ??= []).push(l), a), {});
        return <>
          <Card>
            <p className="ag-meta">{e.type === "person" ? "Person" : e.type === "project" ? "Project knowledge" : e.type}</p>
            <h2 className="ag-title">{e.name}</h2>
            <p className="ag-meta">{Object.entries(e.attrs).filter(([k, v]) => v && !["keywords"].includes(k)).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
            {e.ref?.startsWith("projects:") && <div className="ag-gap-top"><Button size="sm" onClick={() => navigate(`/projects/${e.ref!.split(":")[1]}`)}>Open project</Button></div>}
          </Card>
          <Section title="What I know">
            {e.memories.length
              ? <List className="ag-list">{e.memories.map((m) => <Row key={m.id} title={m.content} meta={`${sourceLine(m.source_kind)} ${relTime(m.observed_at)}`} />)}</List>
              : <p className="ag-note">Nothing yet.</p>}
          </Section>
          <GraphWalk id={e.id} name={e.name} />
          {Object.entries(byType).map(([t, items]) => (
            <Section key={t} title={LINK_LABEL[t] ?? t}>
              <List className="ag-list">{items.map((l) => <Row key={l.id} title={l.name} meta={l.rel?.replace(/_/g, " ")}
                onClick={l.type === "person" || l.type === "project" ? () => setParams({ entity: String(l.id) }) : undefined} />)}</List>
            </Section>
          ))}
        </>;
      }}</Gate>
    </div>
  );
}

function Decide({ items, onDone }: { items: Conflict[]; onDone: () => void }) {
  const toast = useToast();
  if (!items.length) return <EmptyState icon={<Check size={20} />} title="Nothing to decide" line="When two things I've learned disagree, I'll ask you here instead of guessing." />;
  const pick = async (c: Conflict, keep: "old" | "new" | "both") => { try { await api(`/knowledge/conflicts/${c.id}/${keep}`, { body: {} }); onDone(); } catch (e) { toast.err(e); } };
  return <div className="ag-stack">{items.map((c) => (
    <Card key={c.id} className="kn-conflict">
      <h3 className="ag-h3">{c.question}</h3>
      <div className="ag-two ag-gap-top">
        <div className="ag-panel is-sunken"><p className="ag-meta">Earlier, {relTime(c.old.observed_at)}</p>{c.old.content}</div>
        <div className="ag-panel is-sunken"><p className="ag-meta">Newer, {relTime(c.new.observed_at)}</p>{c.new.content}</div>
      </div>
      <div className="ag-bar ag-gap-top">
        <Button onClick={() => pick(c, "old")}>Keep earlier</Button>
        <Button variant="primary" onClick={() => pick(c, "new")}>Keep newer</Button>
        <Button variant="ghost" onClick={() => pick(c, "both")}>Both are true</Button>
      </div>
    </Card>))}</div>;
}

function TidyUp({ tidy, onDone, toast }: { tidy: Tidy; onDone: () => void; toast: ReturnType<typeof useToast> }) {
  const filings = useLoad(() => api<Filing[]>("/knowledge/filings"), []);
  const merge = async (a: Entity, b: Entity) => { try { await api(`/knowledge/merge/${a.id}/${b.id}`, { body: {} }); toast.ok(`Merged into ${a.name}`); onDone(); } catch (e) { toast.err(e); } };
  const dups = tidy.duplicates;
  return (
    <div>
      <Section title="Looks like the same thing">
        {dups.length ? <List className="ag-list">{dups.map((d) => (
          <Row key={`${d.a.id}-${d.b.id}`} title={d.why}
            actions={<><Button size="sm" variant="primary" onClick={() => merge(d.a, d.b)}>Merge</Button><IconButton size="sm" label="Not the same" onClick={() => onDone()}><X size={14} /></IconButton></>} />
        ))}</List> : <p className="ag-note">Nothing to merge.</p>}
      </Section>
      <Section title="Recently filed for you">
        <Gate state={filings} rows={2}>{(list) => list.length ? <List className="ag-list">{list.map((f) => (
          <Row key={f.id} title={f.item_kind} meta={f.reason ? `Because it ${f.reason}` : undefined}
            actions={<FiledChip kind={f.item_kind} itemRef={f.item_ref} initial={f} />} />
        ))}</List> : <p className="ag-note">Nothing filed yet.</p>}</Gate>
      </Section>
    </div>
  );
}
