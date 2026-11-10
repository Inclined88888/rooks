// feat/grok-style: AI teammates. Three panes: teammates (by section), the chat, and a collapsible info pane.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Lock, Plus, Users } from "lucide-react";
import { api, stream } from "../api";
import { Thinking } from "../motion";
import { ApprovalCard as OkCard, Badge, Button, EmptyState, ErrorState, Input, Loading, Page, Select, Tabs, Textarea } from "../ui";
import { plainError } from "../pages/agents/kit";
import "../pages/agents/agents.css";
import "./teammates.css";

export type Teammate = { id: number; name: string; role: string; persona: string; avatar: string; color: string; template: string;
  tools: string[]; section_id: number | null; is_default: number; memory_scope: string };
type Section = { id: number; name: string };
type Template = { key: string; name: string; role: string; avatar: string; blurb?: string };
type Listing = { teammates: Teammate[]; sections: Section[]; templates: Template[]; groups: { id: number; name: string; members: number[] }[] };
export type Draft = { id: number; channel: string; recipients: string; subject: string; body: string; status: string };
export type Form = { id: number; kind: string; label: string; reason: string; status: string; fields: { id: string; label: string; secret: boolean }[] };
export type Choices = { question: string; options: string[] };
type Msg = { role: "user" | "assistant"; text: string; drafts?: Draft[]; forms?: Form[]; approvals?: { id: number; tool: string; reason: string }[]; choices?: Choices };
type History = { conversation_id: number; messages: (Msg & { id: number })[]; drafts: (Draft & { conversation_id?: number })[]; forms: Form[] };

export function Avatar({ t, size = 32 }: { t: Pick<Teammate, "avatar" | "name" | "color">; size?: number }) {
  return <span className={`tm-avatar c-${t.color || "sun"}`} style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
    {t.avatar || t.name.slice(0, 1).toUpperCase()}</span>;
}

export function DraftCard({ d, onDone }: { d: Draft; onDone?: (d: Draft) => void }) {
  const [x, setX] = useState(d);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (what: "send" | "discard") => {
    setBusy(true); setErr("");
    try {
      if (what === "send") await api(`/outbox/${x.id}`, { method: "PATCH", body: { recipients: x.recipients, subject: x.subject, body: x.body } });
      const r = await api<Draft>(`/outbox/${x.id}/${what}`, { method: "POST" });
      setX(r); onDone?.(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const done = x.status !== "draft";
  return <div className="tm-card draft" data-status={x.status}>
    <div className="tm-card-head"><b>Draft {x.channel === "email" ? "email" : `${x.channel} message`}</b>
      <Badge tone={done ? (x.status === "sent" ? "ok" : "neutral") : "accent"}>{done ? (x.status === "sent" ? "Sent" : x.status === "discarded" ? "Discarded" : x.status) : "Not sent until you press Send"}</Badge></div>
    <Input label="To" value={x.recipients} disabled={done} onChange={(e) => setX({ ...x, recipients: e.target.value })} />
    {x.channel === "email" && <Input label="Subject" value={x.subject} disabled={done} onChange={(e) => setX({ ...x, subject: e.target.value })} />}
    <Textarea aria-label="Message" rows={5} value={x.body} disabled={done} onChange={(e) => setX({ ...x, body: e.target.value })} />
    {err && <p className="ag-err">{err}</p>}
    {!done && <div className="ag-bar"><Button size="sm" variant="primary" busy={busy} onClick={() => act("send")}>{busy ? "Sending…" : "Send"}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("discard")}>Discard</Button></div>}
  </div>;
}

export function SecureFormCard({ f }: { f: Form }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [status, setStatus] = useState(f.status);
  const [err, setErr] = useState("");
  const submit = async () => {
    try { await api(`/vault/forms/${f.id}`, { body: { values: vals } }); setStatus("filled"); setVals({}); }
    catch (e) { setErr((e as Error).message); }
  };
  return <div className="tm-card secure">
    <div className="tm-card-head"><b className="ag-bar"><Lock size={14} aria-hidden="true" /> {f.label}</b><Badge>Goes to your Vault. Your teammate never sees it.</Badge></div>
    {f.reason && <p className="ag-note">{f.reason}</p>}
    {status === "open" ? <form className="ag-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {f.fields.map((fl) => <Input key={fl.id} label={fl.label} type={fl.secret ? "password" : "text"} autoComplete="off"
        value={vals[fl.id] ?? ""} onChange={(e) => setVals({ ...vals, [fl.id]: e.target.value })} />)}
      {err && <p className="ag-err">{err}</p>}
      <div className="ag-bar"><Button size="sm" variant="primary" type="submit">Save securely</Button>
        <Button size="sm" variant="ghost" onClick={async () => { try { await api(`/vault/forms/${f.id}/cancel`, { method: "POST" }); setStatus("cancelled"); } catch (e) { setErr((e as Error).message); } }}>Not now</Button></div>
    </form> : <p className="ag-note">{status === "filled" ? "Saved to your Vault." : "Cancelled."}</p>}
  </div>;
}

export function ApprovalCard({ a }: { a: { id: number; tool: string; reason: string } }) {
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (ok: boolean) => {
    setBusy(true);
    try { await api(`/assistant/approvals/${a.id}`, { body: { approve: ok } }); setState(ok ? "Approved" : "Declined"); }
    catch (e) { setState((e as Error).message); } finally { setBusy(false); }
  };
  if (state) return <p className="ag-note">{a.tool.replace(/_/g, " ")}: {state}</p>;
  return <OkCard title={a.tool.replace(/_/g, " ")} detail={a.reason} effect="external" busy={busy} onApprove={() => go(true)} onDeny={() => go(false)} />;
}

/** Quick-reply buttons, only when the teammate asked for them with its offer_choices tool (never guessed from text). */
export function ChoiceCard({ c, onPick }: { c: Choices; onPick: (s: string) => void }) {
  if (c.options.length < 2) return null;
  return <div className="tm-choices" role="group" aria-label={c.question || "Quick replies"}>
    {c.options.map((o) => <Button key={o} size="sm" className="tm-chip" onClick={() => onPick(o)}>{o}</Button>)}</div>;
}

function NewTeammate({ templates, onMade }: { templates: Template[]; onMade: (t: Teammate) => void }) {
  const [pick, setPick] = useState<string>("personal");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  return <div className="tm-new">
    <h2 className="ag-title">New teammate</h2>
    <p className="ag-note">Start from a template. You can change the persona, tools and look any time.</p>
    {!templates.length ? <Loading rows={2} /> : <div className="tm-templates" role="group" aria-label="Templates">{templates.map((t) => <button key={t.key} type="button" aria-pressed={pick === t.key} className={`tm-template${pick === t.key ? " on" : ""}`} onClick={() => setPick(t.key)}>
      <span className="tm-template-avatar" aria-hidden="true">{t.avatar}</span><b>{t.name}</b><span className="ag-meta">{t.role}</span></button>)}</div>}
    <Input label="Name" value={name} placeholder="For example Office manager" onChange={(e) => setName(e.target.value)} />
    {err && <p className="ag-err">{err}</p>}
    <div><Button variant="primary" onClick={async () => {
      try { onMade(await api<Teammate>("/teammates", { body: { template: pick, name: name || undefined } })); } catch (e) { setErr((e as Error).message); }
    }}>Create teammate</Button></div>
  </div>;
}

type Detail = Teammate & { conversations: { id: number; title: string }[]; notes: { id: number; content: string }[];
  computer: { work: string; browser_profile: string; files: { name: string; size: number }[]; runs: { title: string; at: string }[] };
  routines: { id: number; name: string; when?: string; enabled?: number }[] };

function InfoPane({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const [tab, setTab] = useState<"overview" | "routines" | "files" | "computer">("overview");
  const [note, setNote] = useState("");
  const [routine, setRoutine] = useState("");
  const [err, setErr] = useState("");
  return <aside className="tm-info">
    <div className="tm-tabs"><Tabs size="sm" label="Details" value={tab} onChange={(t) => setTab(t as typeof tab)}
      items={(["overview", "routines", "files", "computer"] as const).map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) }))} /></div>
    {tab === "overview" && <div className="tm-pane">
      <div className="tm-hero"><Avatar t={d} size={56} /><div><h3>{d.name}</h3><p className="tm-muted">{d.role}</p></div></div>
      {d.persona && <p>{d.persona}</p>}
      <h4>Tools</h4><p className="tm-muted">{d.tools.length ? d.tools.join(", ") : "Everything you've set up"}</p>
      <h4>What I remember</h4>
      <ul className="tm-list">{d.notes.map((n) => <li key={n.id}>{n.content}
        <Button size="sm" variant="ghost" aria-label={`Forget: ${n.content}`} onClick={async () => { await api(`/teammates/${d.id}/notes/${n.id}`, { method: "DELETE" }); onChanged(); }}>Forget</Button></li>)}</ul>
      <form onSubmit={async (e) => { e.preventDefault(); if (!note.trim()) return; await api(`/teammates/${d.id}/notes`, { body: { content: note } }); setNote(""); onChanged(); }}>
        <Input aria-label="Teach me something" value={note} placeholder="Teach me something" onChange={(e) => setNote(e.target.value)} /></form>
      <div className="tm-row"><a className="btn ghost sm" href={`/api/teammates/${d.id}/template`} download={`${d.name}.json`}>Export template</a></div>
    </div>}
    {tab === "routines" && <div className="tm-pane">
      <ul className="tm-list">{d.routines.map((r) => <li key={r.id}><b>{r.name}</b> <span className="tm-muted">{r.when}</span></li>)}</ul>
      {!d.routines.length && <p className="tm-muted">No routines yet.</p>}
      <form onSubmit={async (e) => { e.preventDefault(); setErr("");
        try { await api(`/teammates/${d.id}/routines`, { body: { text: routine } }); setRoutine(""); onChanged(); } catch (x) { setErr((x as Error).message); } }}>
        <Input aria-label="New routine" value={routine} placeholder="Every weekday at 8am, summarise my inbox" onChange={(e) => setRoutine(e.target.value)} /></form>
      {err && <p className="ag-err">{err}</p>}
      <p className="tm-muted">Routines ask before doing anything that sends or changes things.</p>
    </div>}
    {tab === "files" && <div className="tm-pane"><p className="tm-muted">Working folder: <code className="ag-mono">{d.computer.work}</code></p>
      <ul className="tm-list">{d.computer.files.map((f) => <li key={f.name}>{f.name} <span className="tm-muted">{Math.ceil(f.size / 1024)} KB</span></li>)}</ul>
      {!d.computer.files.length && <p className="tm-muted">Nothing saved yet.</p>}</div>}
    {tab === "computer" && <div className="tm-pane"><p className="tm-muted">It has its own browser, so its sign-ins stay separate from yours.</p>
      <details className="ag-advanced"><summary>Advanced</summary><p className="ag-meta ag-mono">{d.computer.browser_profile}</p></details>
      <ul className="tm-list">{d.computer.runs.map((r, i) => <li key={i}>{r.title} <span className="tm-muted">{r.at}</span></li>)}</ul>
      {!d.computer.runs.length && <p className="tm-muted">No computer sessions yet.</p>}</div>}
  </aside>;
}

export default function Teammates() {
  const { id } = useParams();
  const nav = useNavigate();
  const [list, setList] = useState<Listing | null>(null);
  const [listErr, setListErr] = useState<unknown>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [cid, setCid] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(0);
  const [info, setInfo] = useState(true);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const tid = id && id !== "new" ? Number(id) : null;
  const [params, setParams] = useSearchParams();
  const fresh = useRef(false);

  // The chat is rebuilt from the server, so a reload (or another device) shows the same conversation.
  const openConversation = useCallback(async (t: number, c: number) => {
    try {
      const h = await api<History>(`/teammates/${t}/conversations/${c}`);
      const msgs: Msg[] = h.messages.map((m) => ({ role: m.role, text: m.text, choices: m.choices }));
      const lastA = [...msgs].reverse().find((m) => m.role === "assistant");
      if (lastA) { lastA.drafts = h.drafts; lastA.forms = h.forms.filter((f) => f.status === "pending"); }
      setMsgs(msgs); setCid(c);
    } catch (e) { setErr((e as Error).message); setParams({}, { replace: true }); }
  }, [setParams]);

  const load = useCallback(() => api<Listing>("/teammates").then((l) => { setList(l); setListErr(null); }).catch(setListErr), []);
  const loadDetail = useCallback(() => { if (tid) api<Detail>(`/teammates/${tid}`).then(setDetail).catch((e) => setErr(e.message)); }, [tid]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setMsgs([]); setCid(null); setDetail(null); fresh.current = false; loadDetail(); }, [tid, loadDetail]);
  const wanted = Number(params.get("c")) || null;
  useEffect(() => {
    if (!tid || !detail || detail.id !== tid || busy) return;
    const c = wanted ?? (fresh.current ? null : detail.conversations[0]?.id ?? null);
    if (c && c !== cid) openConversation(tid, c);
  }, [tid, detail, wanted, cid, busy, openConversation]);
  const newChat = () => { fresh.current = true; setMsgs([]); setCid(null); setParams({}, { replace: true }); };
  useEffect(() => { if (!id && list?.teammates.length) nav(`/teammates/${list.teammates[0].id}`, { replace: true }); }, [id, list, nav]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const send = async (m: string) => {
    if (!tid || !m.trim() || busy) return;
    setText(""); setErr(""); setBusy(Date.now());
    setMsgs((x) => [...x, { role: "user", text: m }, { role: "assistant", text: "" }]);
    const patch = (f: (a: Msg) => Msg) => setMsgs((x) => [...x.slice(0, -1), f(x[x.length - 1])]);
    try {
      await stream(`/teammates/${tid}/chat`, { message: m, conversation_id: cid }, (e) => {
        if (e.type === "start") { setCid(e.conversation_id as number); setParams({ c: String(e.conversation_id) }, { replace: true }); }
        else if (e.type === "choices") patch((a) => ({ ...a, choices: { question: String(e.question ?? ""), options: (e.options as string[]) ?? [] } }));
        else if (e.type === "message" && e.content) patch((a) => ({ ...a, text: a.text ? `${a.text}\n\n${String(e.content)}` : String(e.content) }));
        else if (e.type === "draft") patch((a) => ({ ...a, drafts: [...(a.drafts ?? []).filter((d) => d.id !== e.id), e as unknown as Draft] }));
        else if (e.type === "secure_form") patch((a) => ({ ...a, forms: [...(a.forms ?? []).filter((d) => d.id !== e.id), e as unknown as Form] }));
        else if (e.type === "approval_required") patch((a) => ({ ...a, approvals: [...(a.approvals ?? []), { id: Number(e.id), tool: String(e.tool), reason: String(e.reason ?? "") }] }));
        else if (e.type === "error" || (!e.type && e.error)) setErr(String(e.error ?? "Something went wrong"));
      });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(0); loadDetail(); }
  };

  const bySection = (list?.sections ?? []).map((s) => ({ ...s, items: (list?.teammates ?? []).filter((t) => t.section_id === s.id) }));
  const loose = (list?.teammates ?? []).filter((t) => !t.section_id || !list?.sections.some((s) => s.id === t.section_id));
  const none = !!list && !list.teammates.length && id !== "new";
  return <Page wide className="ag-page tm-page-frame" title="Teammates" description="Teammates who each do one kind of work. Anything they want to send comes to you as a draft first."
    actions={<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => nav("/teammates/new")}>New teammate</Button>}>
  {!list && listErr ? <ErrorState title="Your teammates did not load" line={plainError(listErr)} onRetry={load} />
  : none ? <EmptyState icon={<Users size={20} />} title="No teammates yet" line="Start one from a template; it takes a minute."
      action={<Button variant="primary" icon={<Plus size={14} />} onClick={() => nav("/teammates/new")}>New teammate</Button>} />
  : <div className={`tm-shell${info && detail ? " with-info" : ""}`}>
    <nav className="tm-side" aria-label="Teammates">
      <div className="tm-side-head"><h2 className="ag-h3">People</h2></div>
      {!list && <Loading rows={3} />}
      {[...(loose.length ? [{ id: 0, name: "", items: loose }] : []), ...bySection].map((s) => s.items.length ? <section key={s.id}>
        {s.name && <h3>{s.name}</h3>}
        {s.items.map((t) => <button key={t.id} type="button" className={`tm-person${t.id === tid ? " on" : ""}`} aria-current={t.id === tid || undefined} onClick={() => nav(`/teammates/${t.id}`)}>
          <Avatar t={t} /><span><b>{t.name}</b><small>{t.role}</small></span></button>)}
      </section> : null)}
      {!!list?.groups.length && <section><h3>Groups</h3>{list.groups.map((g) => <button key={g.id} type="button" className="tm-person" onClick={() => nav(`/groups/${g.id}`)}>
        <span className="tm-avatar c-sun" aria-hidden="true">#</span><span><b>{g.name}</b><small>{g.members.length} teammates</small></span></button>)}</section>}
      <Button size="sm" variant="ghost" onClick={() => nav("/groups/new")}>New group chat</Button>
    </nav>
    <section className="tm-chat" aria-label="Chat">
      {id === "new" ? <NewTeammate templates={list?.templates ?? []} onMade={(t) => { load(); nav(`/teammates/${t.id}`); }} />
        : detail ? <>
          <header className="tm-chat-head"><Avatar t={detail} /><div><b>{detail.name}</b><small className="tm-muted">{detail.role}</small></div>
            {detail.conversations.length > 1 && <Select className="tm-conv" aria-label="Earlier chats" value={cid ?? ""}
              onChange={(e) => { fresh.current = false; setParams(e.target.value ? { c: e.target.value } : {}); }}>
              {!cid && <option value="">New chat</option>}
              {detail.conversations.map((c) => <option key={c.id} value={c.id}>{c.title || `Chat ${c.id}`}</option>)}</Select>}
            <Button size="sm" variant="ghost" onClick={newChat} disabled={!!busy}>New chat</Button>
            <Button size="sm" variant="ghost" aria-expanded={info} onClick={() => setInfo(!info)}>{info ? "Hide details" : "Details"}</Button></header>
          <div className="tm-msgs" aria-live="polite">
            {!msgs.length && <p className="tm-empty">Ask {detail.name} anything. Anything it wants to send comes to you as a draft first.</p>}
            {msgs.map((m, i) => <div key={i} className={`tm-msg ${m.role}`}>
              {m.text && <div className="tm-bubble">{m.text}</div>}
              {m.approvals?.map((a) => <ApprovalCard key={a.id} a={a} />)}
              {m.drafts?.map((d) => <DraftCard key={d.id} d={d} />)}
              {m.forms?.map((f) => <SecureFormCard key={f.id} f={f} />)}
              {m.role === "assistant" && i === msgs.length - 1 && !busy && m.choices && <ChoiceCard c={m.choices} onPick={send} />}
            </div>)}
            {!!busy && <Thinking since={busy} />}
            <div ref={end} />
          </div>
          {err && <p className="ag-err tm-pad">{err}</p>}
          <form className="tm-compose" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <Textarea aria-label={`Message ${detail.name}`} rows={2} value={text} placeholder={`Message ${detail.name}`} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
            <Button type="submit" variant="primary" disabled={!!busy || !text.trim()}>Send</Button>
          </form>
        </> : err ? <div className="tm-pad tm-state"><ErrorState title="That teammate did not open" line={err} onRetry={loadDetail} /></div>
        : <div className="tm-pad tm-state"><Loading rows={3} /></div>}
    </section>
    {info && detail && id !== "new" && <InfoPane d={detail} onChanged={loadDetail} />}
  </div>}
  </Page>;
}
