// feat/memory-core: Memory - people, project knowledge, what I know (with sources, scopes and why), decisions, tidy-up.
// Premium pass (package C): built on the primitives, with a loading, an empty and an error state on every tab.
import { ArrowLeft, BookMarked, Check, FolderKanban, HelpCircle, Lock, Pin, PinOff, Search, Trash2, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { relTime, useToast } from "../util";
import { Badge, Button, Card, EmptyState, IconButton, Input, List, Page, Row, Section, Tabs } from "../ui";
import { Gate, useLoad } from "../pages/agents/kit";
import { FiledChip } from "./FiledChip";
import GraphWalk from "./GraphWalk";
import { YourData } from "./YourData";
import { Conflict, Entity, EntityDetail, Filing, Mem, SCOPE_LABEL, TIER_LABEL, Tidy, Why } from "./types";
import "./memory.css";

type Tab = "people" | "projects" | "memories" | "decide" | "tidy" | "data";
const TABS: { id: Tab; label: string }[] = [
  { id: "memories", label: "What I know" }, { id: "people", label: "People" }, { id: "projects", label: "Projects" },
  { id: "decide", label: "Needs your call" }, { id: "tidy", label: "Tidy up" }, { id: "data", label: "Your data" },
];

export default function Knowledge() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "memories";
  const entityId = params.get("entity");
  const tidy = useLoad(() => api<Tidy>("/knowledge/tidy"), []);
  const toast = useToast();
  const go = (t: string) => setParams({ tab: t });
  const counts: Partial<Record<Tab, number>> = { decide: tidy.data?.conflicts.length, tidy: tidy.data?.duplicates.length };

  return (
    <Page className="ag-page kn" title="What I know" kicker="Memory"
      description="Everything I remember, who it's about, where it came from and who can see it. Change or forget anything. Sensitive things never leave this computer.">
      {entityId ? <EntityPage id={Number(entityId)} onBack={() => setParams({ tab })} /> : <>
        <div className="kn-tabs">
          <Tabs label="Memory" items={TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] || undefined }))} value={tab} onChange={go} />
        </div>
        {tab === "memories" && <Memories toast={toast} />}
        {tab === "people" && <Entities type="person" icon={<UserRound size={20} />} empty="I add people as they come up in chats, mail, meetings and projects." />}
        {tab === "projects" && <Entities type="project" icon={<FolderKanban size={20} />} empty="Make one on the Projects page and I'll gather what belongs to it." />}
        {tab === "decide" && <Gate state={tidy}>{(t) => <Decide items={t.conflicts} onDone={tidy.reload} />}</Gate>}
        {tab === "tidy" && <Gate state={tidy}>{(t) => <TidyUp tidy={t} onDone={tidy.reload} toast={toast} />}</Gate>}
        {tab === "data" && <YourData toast={toast} />}
      </>}
    </Page>
  );
}

function Memories({ toast }: { toast: ReturnType<typeof useToast> }) {
  const mems = useLoad(() => api<Mem[]>("/knowledge/memories"), []);
  const [q, setQ] = useState("");
  const [why, setWhy] = useState<Record<number, Why>>({});
  const shown = useMemo(() => (mems.data ?? []).filter((m) => !q.trim() || m.content.toLowerCase().includes(q.toLowerCase())), [mems.data, q]);
  const groups = useMemo(() => Object.keys(TIER_LABEL).map((t) => [t, shown.filter((m) => m.tier === t)] as const).filter(([, l]) => l.length), [shown]);
  const patch = async (m: Mem, body: Partial<Mem>) => { try { await api(`/knowledge/memories/${m.id}`, { method: "PATCH", body }); mems.reload(); } catch (e) { toast.err(e); } };
  const forget = async (m: Mem) => { try { await api(`/knowledge/memories/${m.id}`, { method: "DELETE" }); toast.ok("Forgotten"); mems.reload(); } catch (e) { toast.err(e); } };
  const explain = async (m: Mem) => {
    if (why[m.id]) { const n = { ...why }; delete n[m.id]; setWhy(n); return; }
    try { setWhy({ ...why, [m.id]: await api<Why>(`/knowledge/memories/${m.id}/why`) }); } catch (e) { toast.err(e); }
  };
  return (
    <Gate state={mems} rows={5}>{(list) => !list.length
      ? <EmptyState icon={<BookMarked size={20} />} title="Nothing remembered yet" line="As we work I'll keep the useful bits here, with where each one came from." />
      : <div className="ag-stack">
        <div className="kn-search"><Search size={15} aria-hidden="true" /><Input aria-label="Find a memory" placeholder="Find a memory" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {!groups.length && <p className="ag-note">Nothing matches “{q}”.</p>}
        {groups.map(([tier, items]) => (
          <Section key={tier} title={TIER_LABEL[tier]}>
            <List className="ag-list" label={TIER_LABEL[tier]}>
              {items.map((m) => (
                <Row key={m.id} title={m.content}
                  meta={<span className="kn-meta">
                    {m.pinned && <Badge>Pinned</Badge>}
                    {m.privacy === "sensitive" && <Badge tone="warn"><Lock size={10} aria-hidden="true" /> Sensitive, never sent to online models</Badge>}
                    <Badge>{SCOPE_LABEL(m.scope)}</Badge>
                    <span>{m.source_kind === "user" ? "You told me" : "I picked this up"} {relTime(m.observed_at)}</span>
                    {why[m.id] && <span className="kn-why">{why[m.id].summary}{why[m.id].replaced.length ? ` It replaced: “${why[m.id].replaced[0].content}”.` : ""}</span>}
                  </span>}
                  actions={<>
                    <IconButton size="sm" label="Why do you know this?" active={!!why[m.id]} onClick={() => explain(m)}><HelpCircle size={15} /></IconButton>
                    <IconButton size="sm" label={m.pinned ? "Unpin" : "Pin, always keep in mind"} onClick={() => patch(m, { pinned: !m.pinned })}>{m.pinned ? <PinOff size={15} /> : <Pin size={15} />}</IconButton>
                    <IconButton size="sm" label={m.privacy === "sensitive" ? "Mark as normal" : "Mark sensitive"} onClick={() => patch(m, { privacy: m.privacy === "sensitive" ? "normal" : "sensitive" })}><Lock size={15} /></IconButton>
                    <IconButton size="sm" label="Forget this" onClick={() => forget(m)}><Trash2 size={15} /></IconButton>
                  </>} />
              ))}
            </List>
          </Section>
        ))}
      </div>}
    </Gate>
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
              ? <List className="ag-list">{e.memories.map((m) => <Row key={m.id} title={m.content} meta={`${m.source_kind === "user" ? "You told me" : "Picked up"} ${relTime(m.observed_at)}`} />)}</List>
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
