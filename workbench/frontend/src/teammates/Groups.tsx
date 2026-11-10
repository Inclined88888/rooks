// feat/grok-style: group chats. @mention a teammate to bring it in; teammates can hand off with @Name.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../api";
import { Button, EmptyState, ErrorState, Input, Loading, Page, Textarea } from "../ui";
import { plainError } from "../pages/agents/kit";
import { Avatar, type Teammate } from "./Teammates";
import "../pages/agents/agents.css";
import "./teammates.css";

type GMsg = { id: number; author_id: number | null; content: string; handoff_from: number | null; created_at: string; reactions: string[] };
type Group = { id: number; name: string; members: Teammate[]; working: number[] };
const REACTIONS = ["👍", "❤️", "😂", "‼️", "❓", "👀"];

function NewGroup() {
  const nav = useNavigate();
  const [mates, setMates] = useState<Teammate[] | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [again, setAgain] = useState(0);
  const [pick, setPick] = useState<number[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { setLoadErr(null); api<{ teammates: Teammate[] }>("/teammates").then((r) => setMates(r.teammates)).catch(setLoadErr); }, [again]);
  return <div className="tm-new">
    <h2 className="ag-title">New group chat</h2><p className="ag-note">Pick two or more teammates. Mention one with @Name to ask it directly.</p>
    <Input label="Name" value={name} placeholder="For example Kitchen reno" onChange={(e) => setName(e.target.value)} />
    {loadErr ? <ErrorState title="Your teammates did not load" line={plainError(loadErr)} onRetry={() => setAgain((n) => n + 1)} />
      : !mates ? <Loading rows={2} />
      : mates.length < 2 ? <EmptyState title="A group needs two teammates" line="Make another teammate first." action={<Button onClick={() => nav("/teammates/new")}>New teammate</Button>} />
      : <div className="tm-templates">{mates.map((m) => <button key={m.id} type="button" className={`tm-template${pick.includes(m.id) ? " on" : ""}`}
      aria-pressed={pick.includes(m.id)} onClick={() => setPick(pick.includes(m.id) ? pick.filter((x) => x !== m.id) : [...pick, m.id])}>
      <Avatar t={m} /><b>{m.name}</b><span className="ag-meta">{m.role}</span></button>)}</div>}
    {err && <p className="ag-err">{err}</p>}
    <div><Button variant="primary" disabled={pick.length < 2} onClick={async () => {
      try { const g = await api<Group>("/groups", { body: { name, members: pick } }); nav(`/groups/${g.id}`); } catch (e) { setErr((e as Error).message); }
    }}>Start group</Button></div>
  </div>;
}

export function mentionQuery(text: string, caret: number): string | null {
  const m = /@([\w ]{0,30})$/.exec(text.slice(0, caret));
  return m ? m[1] : null;
}

export default function Groups() {
  const { id } = useParams();
  const nav = useNavigate();
  const gid = id && id !== "new" ? Number(id) : null;
  const [group, setGroup] = useState<Group | null>(null);
  const [msgs, setMsgs] = useState<GMsg[]>([]);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!gid) return;
    try { const r = await api<{ group: Group; messages: GMsg[] }>(`/groups/${gid}`); setGroup(r.group); setMsgs(r.messages); } catch (e) { setErr((e as Error).message); }
  }, [gid]);
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length]);
  const back = <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => nav("/teammates")}>Teammates</Button>;
  if (id === "new") return <Page wide className="ag-page tm-page-frame" title="New group chat" kicker="Teammates" actions={back}>
    <div className="tm-shell is-single"><section className="tm-chat" aria-label="Group chat"><NewGroup /></section></div>
  </Page>;
  const byId = new Map((group?.members ?? []).map((m) => [m.id, m]));
  const q = mentionQuery(text, caret);
  const suggestions = q === null ? [] : (group?.members ?? []).filter((m) => m.name.toLowerCase().startsWith(q.toLowerCase())).slice(0, 5);
  const post = async () => {
    if (!text.trim() || !gid) return;
    const t = text; setText("");
    try { await api(`/groups/${gid}/messages`, { body: { content: t } }); load(); } catch (e) { setErr((e as Error).message); setText(t); }
  };
  const react = async (m: GMsg, emoji: string) => {
    const on = !m.reactions.includes(emoji);
    try { await api("/reactions", { body: { scope: "group", ref: m.id, emoji, on } }); load(); } catch (e) { setErr((e as Error).message); }
  };
  return <Page wide className="ag-page tm-page-frame" title={group?.name ?? "Group"} kicker="Group chat" actions={back}>
  {!group && err ? <ErrorState title="This group did not open" line={err} onRetry={load} /> : <div className="tm-shell">
    <nav className="tm-side" aria-label="Group members">
      <h2 className="ag-h3">In this group</h2>
      {!group && <Loading rows={3} />}
      {group?.members.map((m) => <div key={m.id} className="tm-person"><Avatar t={m} /><span><b>{m.name}</b>
        <small>{group.working.includes(m.id) ? "Working…" : m.role}</small></span></div>)}
      <p className="tm-muted">In groups, teammates can't send anything or act outside the app.</p>
    </nav>
    <section className="tm-chat" aria-label="Group chat">
      <div className="tm-msgs" aria-live="polite">
        {!msgs.length && <EmptyState title="No messages yet" line="Say hello, or @mention a teammate to ask it something." />}
        {msgs.map((m) => { const who = m.author_id ? byId.get(m.author_id) : null; return <div key={m.id} className={`tm-msg ${who ? "assistant" : "user"}`}>
          {who && <small className="tm-muted"><Avatar t={who} size={18} /> {who.name}{m.handoff_from ? ` (asked by ${byId.get(m.handoff_from)?.name ?? "a teammate"})` : ""}</small>}
          <div className="tm-bubble">{m.content}</div>
          <div className="tm-reacts">{REACTIONS.map((r) => <button key={r} className={`tm-react${m.reactions.includes(r) ? " on" : ""}`}
            aria-pressed={m.reactions.includes(r)} aria-label={`React ${r}`} onClick={() => react(m, r)}>{r}</button>)}</div>
        </div>; })}
        {group?.working.map((w) => <p key={w} className="tm-muted">{byId.get(w)?.name} is typing…</p>)}
        <div ref={end} />
      </div>
      {err && <p className="ag-err tm-pad">{err}</p>}
      <form className="tm-compose" onSubmit={(e) => { e.preventDefault(); post(); }}>
        {!!suggestions.length && <div className="tm-mentions" role="listbox">{suggestions.map((s) => <button type="button" role="option" aria-selected="false" key={s.id}
          onClick={() => { const before = text.slice(0, caret).replace(/@[\w ]{0,30}$/, `@${s.name} `); setText(before + text.slice(caret)); setCaret(before.length); }}>
          <Avatar t={s} size={18} /> {s.name}</button>)}</div>}
        <Textarea rows={2} value={text} aria-label="Message the group" placeholder="Message the group. Use @ to mention a teammate"
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); } }} />
        <Button type="submit" variant="primary" disabled={!text.trim()}>Send</Button>
      </form>
    </section>
  </div>}
  </Page>;
}
