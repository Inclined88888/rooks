import { ArrowLeft, Inbox, PenLine, PenSquare, RefreshCw, Reply, Send, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, stream } from "../api";
import { Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Select, Tabs, Textarea } from "../ui";
import { relTime, useModels, useToast } from "../util";
import ConnectMailCalendar from "./ConnectMailCalendar";
import { ModelPicker, plainError, Split } from "./day/parts";

type Account = { id: number; name: string; email: string; life_role?: "work" | "personal" | "other" };
const ROLE_LABEL: Record<string, string> = { work: "Work", personal: "Personal", other: "Other" };
type Summary = { uid: string; from: string; subject: string; date: string; unread: boolean };
type Message = Summary & { reply_to: string; to: string; cc: string; message_id: string; body: string };
type Draft = { id: number; account_id: number | null; to_addr: string; subject: string; body: string; in_reply_to: string; updated_at: string };
type Compose = { to: string; subject: string; body: string; in_reply_to: string; draft_id?: number; original?: string };

const sender = (from: string) => from.replace(/<.*>/, "").trim() || from;

function Composer({ account, initial, onClose, onSent }: { account: Account; initial: Compose; onClose: () => void; onSent: () => void }) {
  const [c, setC] = useState(initial);
  const [intent, setIntent] = useState("");
  const [model, setModel] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const { models } = useModels();
  const toast = useToast();
  const abort = useRef<AbortController | null>(null);

  const draft = async () => {
    setDrafting(true);
    abort.current = new AbortController();
    let out = "";
    await stream("/mail/draft-reply", { message: c.original || `To: ${c.to}\nSubject: ${c.subject}`, intent, model: model || null }, (e) => {
      if (e.error) toast.err(String(e.error));
      if (e.delta) { out += e.delta; setC((x) => ({ ...x, body: out.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart() })); }
    }, abort.current.signal).catch(() => undefined);
    setDrafting(false);
  };

  const send = async () => {
    if (!confirm(`Send this email to ${c.to}?`)) return;
    setSending(true);
    try {
      await api(`/mail/${account.id}/send`, { body: { to: c.to, subject: c.subject, body: c.body, in_reply_to: c.in_reply_to, draft_id: c.draft_id ?? null } });
      toast.ok("Sent");
      onSent();
    } catch (e) {
      toast.err(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="day-detail">
      <header className="day-detail-head">
        <IconButton className="day-phone-only" label="Back to the list" size="sm" onClick={onClose}><ArrowLeft size={16} /></IconButton>
        <div className="day-detail-titles">
          <h2 className="day-detail-title">{c.in_reply_to ? "Reply" : "New message"}</h2>
          <p className="day-detail-meta">From {account.email}</p>
        </div>
        <IconButton label="Close" size="sm" onClick={onClose}><X size={16} /></IconButton>
      </header>
      <div className="day-form">
        <Input label="To" value={c.to} onChange={(e) => setC({ ...c, to: e.target.value })} />
        <Input label="Subject" value={c.subject} onChange={(e) => setC({ ...c, subject: e.target.value })} />
        <Card padding="sm" className="day-assist">
          <div className="day-assist-row">
            <PenLine size={16} aria-hidden="true" className="day-muted-icon" />
            <Input className="day-grow" aria-label="What should it say?" placeholder="What should it say? e.g. accept, suggest Thursday 2pm" value={intent} onChange={(e) => setIntent(e.target.value)} />
          </div>
          <div className="day-assist-row">
            <ModelPicker value={model} onChange={setModel} models={models} />
            <Button onClick={draft} busy={drafting}>{drafting ? "Drafting…" : "Draft with AI"}</Button>
          </div>
        </Card>
        <Textarea label="Message" rows={12} value={c.body} onChange={(e) => setC({ ...c, body: e.target.value })} placeholder="Write your message" />
        <div className="day-form-foot">
          <p className="day-hint">AI drafts can contain [placeholders]. Read before sending.</p>
          <Button variant="primary" icon={<Send size={15} />} busy={sending} disabled={!c.to.trim() || !c.body.trim() || drafting} onClick={send}>{sending ? "Sending…" : "Send"}</Button>
        </div>
      </div>
    </div>
  );
}

export default function MailPage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [view, setView] = useState<"inbox" | "drafts">("inbox");
  const [list, setList] = useState<Summary[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const [msg, setMsg] = useState<Message | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const toast = useToast();

  const loadAccounts = () => {
    setAccountsError("");
    return api<Account[]>("/mail/accounts").then((a) => { setAccounts(a); setAccount(a[0] ?? null); })
      .catch((e) => setAccountsError(plainError(e, "Your mail accounts did not load.")));
  };
  useEffect(() => { void loadAccounts(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    if (!account) return;
    setLoading(true);
    setProblem("");
    try {
      if (view === "inbox") setList(await api<Summary[]>(`/mail/${account.id}/messages?q=${encodeURIComponent(q)}`));
      else setDrafts(await api<Draft[]>("/mail/drafts"));
    } catch (e) {
      const m = e instanceof Error ? e.message.trim() : "";
      setProblem(!m || /^\d{3}\b/.test(m) || /gateway timeout/i.test(m) ? "Mail did not answer in time." : m);
      if (view === "inbox") setList([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [account, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (uid: string) => {
    setCompose(null);
    try { setMsg(await api<Message>(`/mail/${account!.id}/messages/${encodeURIComponent(uid)}`)); } catch (e) { toast.err(e); }
  };
  const reply = () => {
    if (!msg) return;
    const quoted = msg.body.split("\n").slice(0, 60).map((l) => `> ${l}`).join("\n");
    setCompose({
      to: msg.reply_to, subject: msg.subject.match(/^re:/i) ? msg.subject : `Re: ${msg.subject}`, in_reply_to: msg.message_id,
      body: `\n\nOn ${msg.date}, ${msg.from} wrote:\n${quoted}`, original: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${msg.body.slice(0, 20000)}`,
    });
  };
  const setRole = async (life_role: Account["life_role"]) => {
    if (!account) return;
    try {
      await api(`/mail/accounts/${account.id}`, { method: "PATCH", body: { life_role } });
      const next = { ...account, life_role };
      setAccount(next);
      setAccounts((all) => (all || []).map((a) => (a.id === account.id ? next : a)));
    } catch (err) { toast.err(err); }
  };
  const removeDraft = async (d: Draft) => {
    try { await api(`/mail/drafts/${d.id}`, { method: "DELETE" }); void load(); } catch (e) { toast.err(e); }
  };
  const newMessage = () => { setMsg(null); setCompose({ to: "", subject: "", body: "", in_reply_to: "" }); };

  const description = "Read and answer your mail here. Nothing is sent until you say so.";
  if (accounts === null) {
    return (
      <Page title="Mail" description={description} className="day-page">
        {accountsError ? <ErrorState title="Mail did not load" line={accountsError} onRetry={() => void loadAccounts()} /> : <Loading rows={6} label="Loading mail" />}
      </Page>
    );
  }
  if (!account) {
    return (
      <Page title="Mail" description="Connect an email address and your mail shows up here." className="day-page">
        <ConnectMailCalendar title="Connect your email" onChange={() => api<Account[]>("/mail/accounts").then((a) => { setAccounts(a); setAccount(a[0] ?? null); }).catch(() => undefined)} />
      </Page>
    );
  }

  const picked = !!(msg || compose);
  const listPane = (
    <>
      <div className="day-split-tools">
        <Tabs label="Mail folders" size="sm" value={view} onChange={(v) => setView(v as "inbox" | "drafts")}
          items={[{ id: "inbox", label: "Inbox" }, { id: "drafts", label: "Drafts", count: drafts.length || undefined }]} />
        {view === "inbox" && (
          <form role="search" onSubmit={(e) => { e.preventDefault(); void load(); }}>
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mail, press Enter" aria-label="Search mail" />
          </form>
        )}
      </div>
      <div className="day-split-scroll">
        {loading && <Loading rows={6} label={view === "inbox" ? "Loading mail" : "Loading drafts"} />}
        {!loading && problem && <div className="day-pad"><ErrorState title="Mail did not load" line={problem} onRetry={() => void load()} /></div>}
        {!loading && !problem && view === "inbox" && (list.length === 0
          ? <EmptyState icon={<Inbox size={22} />} title={q ? "No mail matches that" : "No messages"} line={q ? "Try other words, or clear the search." : "New mail shows up here."}
              action={<Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Check again</Button>} />
          : (
            <List label="Inbox">
              {list.map((m) => (
                <Row key={m.uid} active={msg?.uid === m.uid} onClick={() => void open(m.uid)} className={m.unread ? "day-unread" : undefined}
                  leading={<span className={m.unread ? "day-dot is-live" : "day-dot"} />}
                  title={<>{sender(m.from)}{m.unread && <span className="sr-only"> (unread)</span>}</>}
                  meta={m.subject || "(no subject)"}
                  actions={m.date ? <span className="day-when">{relTime(m.date)}</span> : undefined} />
              ))}
            </List>
          ))}
        {!loading && !problem && view === "drafts" && (drafts.length === 0
          ? <EmptyState icon={<PenSquare size={22} />} title="No drafts" line="Chat saves drafts here. Nothing is sent until you say so." action={<Button size="sm" onClick={newMessage}>Write a message</Button>} />
          : (
            <List label="Drafts">
              {drafts.map((d) => (
                <Row key={d.id} active={compose?.draft_id === d.id} title={d.subject || "(no subject)"} meta={`To ${d.to_addr} · ${relTime(d.updated_at)}`}
                  onClick={() => { setMsg(null); setCompose({ to: d.to_addr, subject: d.subject, body: d.body, in_reply_to: d.in_reply_to, draft_id: d.id }); }}
                  actions={<IconButton label={`Delete draft ${d.subject || ""}`.trim()} size="sm" onClick={() => void removeDraft(d)}><Trash2 size={14} /></IconButton>} />
              ))}
            </List>
          ))}
      </div>
    </>
  );

  const mainPane = compose ? (
    <Composer key={compose.draft_id ?? compose.in_reply_to ?? "new"} account={account} initial={compose} onClose={() => setCompose(null)} onSent={() => { setCompose(null); void load(); }} />
  ) : msg ? (
    <article className="day-detail">
      <header className="day-detail-head">
        <IconButton className="day-phone-only" label="Back to the list" size="sm" onClick={() => setMsg(null)}><ArrowLeft size={16} /></IconButton>
        <div className="day-detail-titles">
          <h2 className="day-detail-title">{msg.subject || "(no subject)"}</h2>
          <p className="day-detail-meta">From {msg.from}</p>
          <p className="day-detail-meta">To {msg.to}{msg.cc ? ` · Cc ${msg.cc}` : ""}</p>
          <p className="day-detail-meta">{msg.date}</p>
        </div>
        <Button variant="primary" size="sm" icon={<Reply size={14} />} onClick={reply}>Reply</Button>
      </header>
      <div className="day-mail-body">{msg.body || <span className="day-hint">(No text content)</span>}</div>
    </article>
  ) : (
    <EmptyState title="Pick a message to read it" line="Or start a new one." action={<Button size="sm" icon={<PenSquare size={14} />} onClick={newMessage}>New message</Button>} />
  );

  return (
    <Page title="Mail" description={description} wide className="day-page"
      actions={(
        <>
          {accounts.length > 1 ? (
            <Select aria-label="Mail account" className="day-account" value={account.id} onChange={(e) => setAccount(accounts.find((a) => a.id === Number(e.target.value))!)}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{ROLE_LABEL[a.life_role || "other"]}: {a.email}</option>)}
            </Select>
          ) : <span className="day-account-name" title={account.email}>{account.email}</span>}
          <Select aria-label="Is this work or personal mail?" title="Is this work or personal mail?" className="day-role" value={account.life_role || "other"}
            onChange={(e) => void setRole(e.target.value as Account["life_role"])}>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
            <option value="other">Other</option>
          </Select>
          <IconButton label="Check for new mail" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /></IconButton>
          <Button variant="primary" icon={<PenSquare size={15} />} onClick={newMessage}>New message</Button>
        </>
      )}>
      <Split label="Mail" picked={picked} list={listPane} main={mainPane} />
    </Page>
  );
}
