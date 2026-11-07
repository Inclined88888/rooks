// Talk to your teammates from Slack, Discord, Telegram, Matrix, Signal, WhatsApp or email, plus the phone link settings.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading, Page, Select, Textarea } from "../ui";
import { plainError } from "../pages/agents/kit";
import "../pages/agents/agents.css";
import "./teammates.css";

type Mate = { id: number; name: string };
type Status = {
  slack: { configured: boolean; running?: boolean; error?: string; allowed_users: string; teammate: number; steps: string[]; manifest: unknown };
  discord: { configured: boolean; running: boolean; bot?: string; error?: string; allowed_users: string; teammate: number; steps: string[]; invite_url: string };
  telegram: { configured: boolean; running: boolean; bot?: string; error?: string; allowed_users?: string; teammate: number; steps: string[] };
  matrix: More & { homeserver: string };
  signal: More & { api_url: string; number: string };
  whatsapp: More & { phone_number_id: string; webhook_path: string };
  email: More & { account_id: string; subject_tag: string };
};
type More = { configured: boolean; running: boolean; error?: string; account?: string; allowed_users: string; teammate: number; steps: string[] };
type Field = { key: string; label: string; secret?: boolean; initial?: string; placeholder?: string };

/** Matrix, Signal, WhatsApp, email: the same card, its fields from the list. Secrets are only sent when typed. */
function MoreChannel({ name, title, st, fields, test, pickMate, save, children }: {
  name: string; title: string; st: More; fields: Field[]; test?: boolean; children?: React.ReactNode;
  pickMate: (v: number, f: (n: number) => void) => React.ReactNode; save: (path: string, body: unknown, method?: string) => Promise<void>;
}) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.secret ? "" : f.initial ?? ""])));
  const body = () => Object.fromEntries(fields.filter((f) => !f.secret || v[f.key]).map((f) => [f.key, v[f.key]]));
  return <Card as="section" className="tm-card wide">
    <div className="tm-card-head"><b>{title}</b><Badge>{st.running ? `Connected${st.account ? ` as ${st.account}` : ""}` : st.configured ? "Set up" : "Not set up"}</Badge></div>
    <Wizard steps={st.steps}>
      {fields.map((f) => <Input key={f.key} label={f.label} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.placeholder}
        value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />)}
      {children}
      {pickMate(st.teammate, (n) => save(`/channels/${name}`, { teammate_id: n }))}
      {st.error && <p className="ag-err">{st.error}</p>}
      <div className="tm-row"><button className="btn primary sm" onClick={() => save(`/channels/${name}`, body())}>Save</button>
        {test && <button className="btn ghost sm" onClick={() => save(`/channels/${name}/test`, {}, "POST")}>Test connection</button>}</div>
    </Wizard>
  </Card>;
}
type Link = { computer_id: string; relay_url: string; relay: { connected?: boolean; error?: string }; linked_phones: number; lan: string[]; shared_folders: string[] };

function Wizard({ steps, children }: { steps: string[]; children: React.ReactNode }) {
  const [i, setI] = useState(0);
  return <div className="tm-wizard">
    <ol>{steps.map((s, n) => <li key={n} className={n === i ? "on" : n < i ? "done" : ""}><button type="button" aria-current={n === i ? "step" : undefined} onClick={() => setI(n)}>{s}</button></li>)}</ol>
    <div className="tm-row"><button className="btn ghost sm" disabled={i === 0} onClick={() => setI(i - 1)}>Back</button>
      <button className="btn ghost sm" disabled={i >= steps.length - 1} onClick={() => setI(i + 1)}>Next step</button></div>
    {children}
  </div>;
}

export default function Channels() {
  const nav = useNavigate();
  const [st, setSt] = useState<Status | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [mates, setMates] = useState<Mate[]>([]);
  const [slack, setSlack] = useState({ bot_token: "", app_token: "", allowed_users: "" });
  const [tg, setTg] = useState({ bot_token: "", allowed_users: "" });
  const [dc, setDc] = useState({ bot_token: "", allowed_users: "" });
  const [folders, setFolders] = useState("");
  const [relay, setRelay] = useState("");
  const [msg, setMsg] = useState("");
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [mailAccounts, setMailAccounts] = useState<{ id: number; email: string }[]>([]);
  useEffect(() => { api<{ id: number; email: string }[]>("/mail/accounts").then(setMailAccounts).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    const [s, l, m] = await Promise.all([api<Status>("/channels"), api<Link>("/link"), api<{ teammates: Mate[] }>("/teammates")]);
    setSt(s); setLink(l); setMates(m.teammates); setFolders(l.shared_folders.join("\n")); setRelay(l.relay_url);
    setSlack((x) => ({ ...x, allowed_users: s.slack.allowed_users })); setTg((x) => ({ ...x, allowed_users: s.telegram.allowed_users ?? "" }));
    setDc((x) => ({ ...x, allowed_users: s.discord.allowed_users }));
  }, []);
  const retry = useCallback(() => { setLoadErr(null); load().catch(setLoadErr); }, [load]);
  useEffect(() => { retry(); }, [retry]);
  const save = async (path: string, body: unknown, method = "PUT") => {
    setMsg("");
    try { await api(path, { method, body }); setMsg("Saved."); load(); } catch (e) { setMsg((e as Error).message); }
  };
  const desc = "Message your teammates from Slack, Discord, Telegram, Matrix, Signal, WhatsApp or email. They answer there, but anything that sends or changes things waits for you in the app.";
  if (!st || !link) return (
    <Page className="ag-page tm-settings" title="Channels and phone" description={desc}>
      {loadErr ? <ErrorState title="Channels did not load" line={plainError(loadErr)} onRetry={retry} /> : <Loading rows={5} />}
    </Page>
  );
  const pickMate = (v: number, f: (n: number) => void) => <Select label="Who answers" value={v} onChange={(e) => f(Number(e.target.value))}>
    {mates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>;
  return <Page className="ag-page tm-settings" title="Channels and phone" description={desc}>
    <p className="ag-note tm-status" role="status">{msg}</p>
    {!mates.length && <Card><EmptyState title="No one to answer yet" line="Make a teammate first, then pick who answers on each channel."
      action={<Button variant="primary" onClick={() => nav("/teammates/new")}>New teammate</Button>} /></Card>}
    <Card as="section" className="tm-card wide">
      <div className="tm-card-head"><b>Slack</b><Badge>{st.slack.configured ? (st.slack.running ? "Connected" : "Set up") : "Not set up"}</Badge></div>
      <Wizard steps={st.slack.steps}>
        <details className="ag-advanced"><summary>App manifest</summary><pre className="tm-pre">{JSON.stringify(st.slack.manifest, null, 2)}</pre>
          <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(JSON.stringify(st.slack.manifest, null, 2))}>Copy manifest</button></details>
        <Input label="Bot token (xoxb-…)" type="password" autoComplete="off" value={slack.bot_token} onChange={(e) => setSlack({ ...slack, bot_token: e.target.value })} />
        <Input label="App-level token (xapp-…)" type="password" autoComplete="off" value={slack.app_token} onChange={(e) => setSlack({ ...slack, app_token: e.target.value })} />
        <Input label="Your Slack member IDs (comma separated)" value={slack.allowed_users} onChange={(e) => setSlack({ ...slack, allowed_users: e.target.value })} />
        {pickMate(st.slack.teammate, (n) => save("/channels/slack", { teammate_id: n }))}
        {st.slack.error && <p className="ag-err">{st.slack.error}</p>}
        <div className="tm-row"><button className="btn primary sm" onClick={() => save("/channels/slack", {
          ...(slack.bot_token ? { bot_token: slack.bot_token } : {}), ...(slack.app_token ? { app_token: slack.app_token } : {}), allowed_users: slack.allowed_users })}>Save</button>
          <button className="btn ghost sm" onClick={() => save("/channels/slack/test", {}, "POST")}>Test connection</button></div>
      </Wizard>
    </Card>
    <Card as="section" className="tm-card wide">
      <div className="tm-card-head"><b>Discord</b><Badge>{st.discord.running ? `Connected${st.discord.bot ? ` as ${st.discord.bot}` : ""}` : st.discord.configured ? "Set up" : "Not set up"}</Badge></div>
      <Wizard steps={st.discord.steps}>
        <Input label="Bot token" type="password" autoComplete="off" value={dc.bot_token} onChange={(e) => setDc({ ...dc, bot_token: e.target.value })} />
        <Input label="Your Discord user IDs (comma separated)" value={dc.allowed_users} onChange={(e) => setDc({ ...dc, allowed_users: e.target.value })} />
        {pickMate(st.discord.teammate, (n) => save("/channels/discord", { teammate_id: n }))}
        {st.discord.invite_url && <p className="tm-muted"><a href={st.discord.invite_url} target="_blank" rel="noreferrer">Invite the bot to a server</a> (DMs work without one). It answers DMs and messages that @mention it.</p>}
        {st.discord.error && <p className="ag-err">{st.discord.error}</p>}
        <div className="tm-row"><button className="btn primary sm" onClick={() => save("/channels/discord", { ...(dc.bot_token ? { bot_token: dc.bot_token } : {}), allowed_users: dc.allowed_users })}>Save</button>
          <button className="btn ghost sm" onClick={() => save("/channels/discord/test", {}, "POST")}>Test connection</button></div>
      </Wizard>
    </Card>
    <Card as="section" className="tm-card wide">
      <div className="tm-card-head"><b>Telegram</b><Badge>{st.telegram.running ? `Running${st.telegram.bot ? ` as @${st.telegram.bot}` : ""}` : st.telegram.configured ? "Set up" : "Not set up"}</Badge></div>
      <Wizard steps={st.telegram.steps}>
        <Input label="Bot token" type="password" autoComplete="off" value={tg.bot_token} onChange={(e) => setTg({ ...tg, bot_token: e.target.value })} />
        <Input label="Your Telegram user IDs" value={tg.allowed_users} onChange={(e) => setTg({ ...tg, allowed_users: e.target.value })} />
        {pickMate(st.telegram.teammate, (n) => save("/channels/telegram", { teammate_id: n }))}
        {st.telegram.error && <p className="ag-err">{st.telegram.error}</p>}
        <button className="btn primary sm" onClick={() => save("/channels/telegram", { ...(tg.bot_token ? { bot_token: tg.bot_token } : {}), allowed_users: tg.allowed_users })}>Save</button>
      </Wizard>
    </Card>
    <MoreChannel name="matrix" title="Matrix" st={st.matrix} test pickMate={pickMate} save={save} fields={[
      { key: "homeserver", label: "Homeserver URL", initial: st.matrix.homeserver, placeholder: "https://matrix.org" },
      { key: "access_token", label: "Bot access token", secret: true },
      { key: "allowed_users", label: "Matrix IDs allowed to ask (comma separated)", initial: st.matrix.allowed_users, placeholder: "@you:matrix.org" }]}>
      <p className="tm-muted">Unencrypted rooms and direct chats only: end-to-end encrypted rooms can't be read yet.</p>
    </MoreChannel>
    <MoreChannel name="signal" title="Signal" st={st.signal} test pickMate={pickMate} save={save} fields={[
      { key: "api_url", label: "signal-cli-rest-api URL", initial: st.signal.api_url, placeholder: "http://localhost:8080" },
      { key: "number", label: "Your Signal number", initial: st.signal.number, placeholder: "+61412345678" },
      { key: "allowed_users", label: "Numbers allowed to ask (comma separated)", initial: st.signal.allowed_users }]} />
    <MoreChannel name="whatsapp" title="WhatsApp" st={st.whatsapp} pickMate={pickMate} save={save} fields={[
      { key: "phone_number_id", label: "Phone number ID", initial: st.whatsapp.phone_number_id },
      { key: "access_token", label: "Access token", secret: true },
      { key: "app_secret", label: "App secret", secret: true },
      { key: "verify_token", label: "Verify token (any text you choose)", secret: true },
      { key: "allowed_users", label: "WhatsApp numbers allowed to ask (comma separated)", initial: st.whatsapp.allowed_users }]}>
      <p className="tm-muted">Meta delivers WhatsApp messages only to a public HTTPS address: set the webhook to <code className="ag-mono">https://your-address{st.whatsapp.webhook_path}</code>.</p>
    </MoreChannel>
    <MoreChannel name="email" title="Email" st={st.email} pickMate={pickMate} save={save} fields={[
      { key: "allowed_users", label: "Addresses allowed to ask (comma separated)", initial: st.email.allowed_users },
      { key: "subject_tag", label: "Subject starts with", initial: st.email.subject_tag }]}>
      <Select label="Mail account" defaultValue={st.email.account_id} onChange={(e) => save("/channels/email", { account_id: Number(e.target.value) })}>
        <option value="">Choose…</option>{mailAccounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</Select>
    </MoreChannel>
    <Card as="section" className="tm-card wide">
      <div className="tm-card-head"><b>Phone link</b><Badge>{link.linked_phones} phone{link.linked_phones === 1 ? "" : "s"} linked</Badge></div>
      <p className="tm-muted">End-to-end encrypted. Your phone talks to this computer over Wi-Fi first, and through the relay when you're away. The relay only ever sees sealed envelopes.</p>
      <details className="ag-advanced"><summary>Advanced</summary><p className="ag-meta ag-mono">Computer ID {link.computer_id}{link.lan.length ? ` · on this network at ${link.lan[0]}` : ""}</p></details>
      <Input label="Relay address (https)" value={relay} placeholder="https://relay.example.com" onChange={(e) => setRelay(e.target.value)} />
      {link.relay.error && <p className="ag-err">{link.relay.error}</p>}
      <Textarea label="Folders your phone can browse (one per line, read only)" rows={3} value={folders} onChange={(e) => setFolders(e.target.value)} />
      <button className="btn primary sm" onClick={() => save("/link", { relay_url: relay, shared_folders: folders.split("\n").map((x) => x.trim()).filter(Boolean) })}>Save</button>
      <p className="tm-muted">To link a phone, open the Phone page and scan the pairing code with Rooks.</p>
    </Card>
  </Page>;
}
