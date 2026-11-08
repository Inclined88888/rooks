import { AlertTriangle, CalendarDays, Check, ExternalLink, Laptop, Mail, RefreshCw, X } from "lucide-react";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Button, Card, ErrorState, IconButton, Input, Loading, Select, Tabs } from "../ui";
import { useToast } from "../util";
import "../connect.css";
import { AppleMark, ProviderLogo, type Provider } from "./day/logos";
import { Busy, CheckField, Disclosure, Notice, plainError, Steps } from "./day/parts";
import { openExternal } from "../desktop";

export { ProviderLogo };

type ProviderInfo = { configured: boolean; source: string; message: string; tenant: string; client_id_hint: string };
type Linked = { id: number; provider: Provider; email: string; name: string; status: "connected" | "reauth"; last_error: string; mail_account_id: number | null; calendar_id: number | null };
type MailAccount = { id: number; name: string; email: string; kind?: string; imap_host: string };
type Cal = { id: number; name: string; kind: string; color: string };
type Detected = {
  kind: "one_click" | "known" | "guess" | "invalid" | "unavailable"; provider?: Provider; workspace?: boolean; label?: string; message?: string;
  imap_host?: string; imap_port?: number; smtp_host?: string; smtp_port?: number; smtp_security?: "ssl" | "starttls";
  caldav_url?: string; app_password?: boolean; app_password_url?: string; steps?: string[]; username_hint?: string; source?: string;
  calendar_help?: string[]; key?: string;
  fallback?: Detected; one_click_unavailable?: Provider; mac?: boolean;
};
type MacAccount = { name: string; emails: string[]; enabled: boolean; type: string; connected: boolean };

const NAMES: Record<Provider, string> = { google: "Google", microsoft: "Microsoft" };
const WHAT: Record<Provider, string> = { google: "Gmail and Google Calendar", microsoft: "Outlook, Hotmail, Microsoft 365 mail and calendar" };

/** "Connect your mail & calendar": one sign-in with Google or Microsoft sets up both; other providers by app password. */
export default function ConnectMailCalendar({ compact = false, onlyWhenEmpty = false, onChange, title = "Mail" }: { compact?: boolean; onlyWhenEmpty?: boolean; onChange?: () => void; title?: string }) {
  const [providers, setProviders] = useState<Record<Provider, ProviderInfo> | null>(null);
  const [linked, setLinked] = useState<Linked[]>([]);
  const [imap, setImap] = useState<MailAccount[]>([]);
  const [cals, setCals] = useState<Cal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [pending, setPending] = useState<{ provider: Provider; url: string; state: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState("");
  const timer = useRef<number>();
  const toast = useToast();

  const load = async () => {
    let failed = 0;
    const miss = <T,>(v: T) => () => { failed += 1; return v; };
    const [p, l, m, c] = await Promise.all([
      api<Record<Provider, ProviderInfo>>("/connect/providers").catch(miss(null)),
      api<Linked[]>("/connect/accounts").catch(miss([] as Linked[])),
      api<MailAccount[]>("/mail/accounts").catch(miss([] as MailAccount[])),
      api<Cal[]>("/calendars").catch(miss([] as Cal[])),
    ]);
    setProviders(p); setLinked(l); setImap(m.filter((a) => !a.kind || a.kind === "imap" || a.kind === "mac")); setCals(c.filter((x) => x.kind === "caldav" || x.kind === "ics"));
    setUnreachable(failed === 4);
    setLoaded(true);
  };
  useEffect(() => { void load(); return () => window.clearInterval(timer.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = (s: { status: string; error?: string; email?: string }) => {
    if (s.status === "pending") return false;
    window.clearInterval(timer.current);
    setPending(null); setPasted("");
    if (s.status === "connected") { toast.ok(`${s.email} is connected for mail and calendar`); void load(); onChange?.(); }
    else setError(s.error || "That sign-in didn't finish. Try again.");
    return true;
  };

  const connect = async (provider: Provider, hint = "") => {
    setError("");
    const info = providers?.[provider];
    if (info && !info.configured) { setError(`Sign-in with ${NAMES[provider]} isn't ready on this computer. Type the email address below.`); return; }
    try {
      const r = await api<{ url: string; state: string; opened: boolean }>(`/connect/${provider}/start`, { body: { login_hint: hint } });
      if (!r.opened) void openExternal(r.url);
      setPending({ provider, url: r.url, state: r.state });
      window.clearInterval(timer.current);
      timer.current = window.setInterval(async () => {
        const st = await api<{ status: string; error?: string; email?: string }>(`/connect/status/${r.state}`).catch(() => null);
        if (st) finished(st);
      }, 1500);
    } catch (e) {
      if ((e as { status?: number }).status === 409) setError(`Sign-in with ${NAMES[provider]} isn't ready on this computer. Type the email address below.`); else setError(plainError(e));
    }
  };

  const completePasted = async () => {
    const st = await api<{ status: string; error?: string; email?: string }>("/connect/complete", { body: { url: pasted.trim() } }).catch((e) => ({ status: "failed", error: plainError(e) }));
    finished(st);
  };

  const disconnect = async (a: Linked) => {
    if (!confirm(`Disconnect ${a.email}? Its mail and calendar are removed from Rooks (nothing is deleted at ${NAMES[a.provider]}).`)) return;
    try { const r = await api<{ note: string }>(`/connect/accounts/${a.id}`, { method: "DELETE" }); toast.ok(r.note); void load(); onChange?.(); } catch (e) { toast.err(e); }
  };
  const removeImap = async (a: MailAccount) => {
    if (!confirm(`Disconnect ${a.email}?`)) return;
    await api(`/mail/accounts/${a.id}`, { method: "DELETE" }).catch(toast.err); void load(); onChange?.();
  };

  if (onlyWhenEmpty && (!loaded || linked.length || imap.length || cals.length)) return null;
  const anything = linked.length + imap.length + cals.length > 0;
  const oneClick = (["google", "microsoft"] as Provider[]).filter((p) => providers?.[p]?.configured);
  const openApple = async () => {
    setError("");
    try { await api("/mail/mac/settings", { method: "POST" }); }
    catch (e) { setError(plainError(e)); }
  };

  return (
    <Card as="section" className={`cmc${compact ? " is-compact" : ""}`} id="mail" aria-labelledby="cmc-title">
      <div className="cmc-head">
        <div className="cmc-titles">
          <h2 id="cmc-title" className="cmc-title">{title}</h2>
          <p className="cmc-line">Work mail uses that company's own sign-in. Nothing is sent until you say so.</p>
        </div>
        {anything && <IconButton label="Refresh" size="sm" onClick={() => void load()}><RefreshCw size={14} /></IconButton>}
      </div>

      {!loaded ? <Loading rows={2} label="Checking your mail accounts" /> : unreachable ? (
        <ErrorState title="Your mail accounts did not load" line="The app did not answer. Check that it is running, then try again." onRetry={() => void load()} />
      ) : (
        <>
          <div className="cmc-buttons" aria-label="Companies" role="group">
            {(["google", "microsoft"] as Provider[]).map((p) => (
              <Button key={p} className="cmc-btn" disabled={!!pending} onClick={() => void connect(p)} title={WHAT[p]} icon={<ProviderLogo provider={p} />}>
                {pending?.provider === p ? `Waiting for ${NAMES[p]}…` : NAMES[p]}
              </Button>
            ))}
            {ON_MAC && <Button className="cmc-btn" onClick={() => void openApple()} title="Apple" icon={<AppleMark />}>Apple</Button>}
          </div>

          {anything && (
            <ul className="cmc-accounts" aria-label="Connected">
              {linked.map((a) => (
                <li key={`l${a.id}`} className={`cmc-account${a.status === "reauth" ? " is-reauth" : ""}`} title={a.last_error || `${a.name} · ${NAMES[a.provider]}`}>
                  <ProviderLogo provider={a.provider} />
                  <span className="cmc-account-email">{a.email}</span>
                  <span className="cmc-account-what">{[a.mail_account_id && "Mail", a.calendar_id && "Calendar"].filter(Boolean).join(" + ")}</span>
                  {a.status === "reauth"
                    ? <Button size="sm" icon={<AlertTriangle size={13} />} onClick={() => void connect(a.provider, a.email)}>Sign in again</Button>
                    : <Check size={14} className="cmc-ok" aria-label="Connected" />}
                  <IconButton label={`Disconnect ${a.email}`} size="sm" onClick={() => void disconnect(a)}><X size={13} /></IconButton>
                </li>
              ))}
              {imap.map((a) => (
                <li key={`m${a.id}`} className="cmc-account">
                  {a.kind === "mac" ? <Laptop size={14} aria-hidden="true" /> : <Mail size={14} aria-hidden="true" />}
                  <span className="cmc-account-email">{a.email}</span>
                  <span className="cmc-account-what">{a.kind === "mac" ? "On this Mac" : "Mail"}</span>
                  <IconButton label={`Disconnect ${a.email}`} size="sm" onClick={() => void removeImap(a)}><X size={13} /></IconButton>
                </li>
              ))}
              {cals.map((c) => (
                <li key={`c${c.id}`} className="cmc-account">
                  <CalendarDays size={14} aria-hidden="true" />
                  <Link to="/calendar" className="cmc-account-email" title="Manage on the Calendar page">{c.name}</Link>
                  <span className="cmc-account-what">Calendar</span>
                </li>
              ))}
            </ul>
          )}

          {pending && (
            <Notice title={`Finish signing in with ${NAMES[pending.provider]}, then come back here.`}
              actions={<Button variant="ghost" size="sm" onClick={() => { window.clearInterval(timer.current); setPending(null); }}>Cancel</Button>}>
              <p><a className="cmc-link" href={pending.url} target="_blank" rel="noreferrer">Open the sign-in page <ExternalLink size={12} aria-hidden="true" /></a></p>
              <Disclosure summary="Signed in on another device">
                <div className="cmc-row">
                  <Input className="cmc-grow" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the page address" aria-label="Page address" />
                  <Button size="sm" disabled={!pasted.includes("state=")} onClick={() => void completePasted()}>Finish</Button>
                </div>
              </Disclosure>
            </Notice>
          )}
          {error && <ErrorState title="That did not connect" line={error} />}

          {!compact && <OtherProvider onSuggest={(p, email) => void connect(p, email)} onAdded={() => { void load(); onChange?.(); }} />}
          {compact && !oneClick.length && <Link className="ui-btn ui-btn-secondary cmc-self-start" to="/mail">Add an email address</Link>}

          {!compact && <OwnRegistration providers={providers} onSaved={() => void load()} />}
        </>
      )}
    </Card>
  );
}

const ON_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || "") && !/iPhone|iPad/.test(navigator.userAgent);

/** Whose sign-in window to open: Google for Gmail, Apple for iCloud, and so on. */
function signer(d: Detected | null): string {
  if (!d) return "your email provider";
  if (d.provider === "google" || d.key === "gmail" || d.one_click_unavailable === "google") return "Google";
  if (d.provider === "microsoft" || d.one_click_unavailable === "microsoft") return "Microsoft";
  if (d.key === "icloud") return "Apple";
  if (d.key === "yahoo") return "Yahoo";
  if (d.key === "aol") return "AOL";
  return brand(d);
}

function PasswordShell({ mac, children }: { mac: boolean; children: ReactNode }) {
  if (!mac) return <>{children}</>;
  return <Disclosure summary="Use a password instead">{children}</Disclosure>;
}

/** Opens the Mac's own account window (Google, Microsoft, Apple, Yahoo) and connects the address once it appears. */
function MacSignIn({ email, who, onAdded }: { email: string; who: string; onAdded: () => void }) {
  const [accounts, setAccounts] = useState<MacAccount[] | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const timer = useRef<number>();
  const lower = email.toLowerCase();

  const look = async () => {
    const r = await api<{ available: boolean; accounts: MacAccount[]; error?: string }>("/mail/mac").catch((e) => ({ available: false, accounts: [] as MacAccount[], error: plainError(e) }));
    setAccounts(r.accounts);
    if (r.error) setError(r.error);
    return r;
  };
  useEffect(() => () => window.clearInterval(timer.current), []);

  const finish = async (name: string) => {
    window.clearInterval(timer.current);
    try {
      await api("/mail/mac", { body: { name, email } });
      toast.ok(`${email} is connected`);
      onAdded();
    } catch (e) {
      setError(plainError(e));
      setWaiting(false);
    }
  };

  const start = async () => {
    setError("");
    setWaiting(true);
    try {
      await api("/mail/mac/settings", { method: "POST" });
    } catch (e) {
      setError(plainError(e));
      setWaiting(false);
      return;
    }
    const until = Date.now() + 3 * 60 * 1000;
    window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      const r = await look();
      const hit = r.accounts.find((a) => a.emails.some((x) => x.toLowerCase() === lower));
      if (hit?.enabled) { await finish(hit.name); return; }
      if (hit && !hit.enabled) setError(`Signed in. In that window, open ${hit.name} and turn on Mail.`);
      else if (Date.now() > until) { window.clearInterval(timer.current); setWaiting(false); setError("Finish signing in in the window, then press the button again."); }
    }, 2000);
  };

  const match = accounts?.find((a) => a.emails.some((x) => x.toLowerCase() === lower));
  return (
    <div className="cmc-stack">
      {match?.enabled ? (
        <div className="cmc-row">
          <Laptop size={15} aria-hidden="true" /><span className="cmc-grow cmc-small"><strong>{email}</strong> is already signed in on this Mac.</span>
          <Button variant="primary" size="sm" onClick={() => void finish(match.name)}>Connect</Button>
        </div>
      ) : (
        <>
          <Button variant="primary" className="cmc-self-start" busy={waiting} onClick={() => void start()}>{waiting ? `Waiting for ${who}…` : `Sign in with ${who}`}</Button>
          <p className="cmc-small cmc-muted">
            {waiting
              ? `Waiting for you to finish. In the window, choose Add Account, pick ${who}, and sign in as usual. Your password stays with ${who}.`
              : `A window from your Mac opens. Choose Add Account, pick ${who}, and sign in as usual. Your password stays with ${who}.`}
          </p>
        </>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/** "Gmail", "iCloud", "Yahoo" from labels like "Gmail (app password)" or "iCloud Mail". */
function brand(d: Detected): string {
  return (d.label || "Your provider").replace(/\s*\(.*\)$/, "").replace(/ Mail$/, "");
}
/** Whose account page the app password is made on: Google for Gmail, Apple for iCloud. */
function owner(d: Detected): string {
  return ({ gmail: "Google", icloud: "Apple" } as Record<string, string>)[d.key ?? ""] ?? brand(d);
}

function OtherProvider({ onSuggest, onAdded, plain = false }: { onSuggest: (p: Provider, email: string) => void; onAdded: () => void; plain?: boolean }) {
  const [email, setEmail] = useState("");
  const [det, setDet] = useState<Detected | null>(null);
  const [checking, setChecking] = useState(false);
  const [form, setForm] = useState({ name: "", username: "", password: "", imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 465, smtp_security: "ssl" as "ssl" | "starttls" });
  const [addCal, setAddCal] = useState(true);
  const [showServers, setShowServers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<{ email: string; calendar: string[] | null } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();

  const detect = async (value = email) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) { setDet(null); return; }
    setChecking(true);
    try {
      const d = await api<Detected>(`/mail/autodetect?email=${encodeURIComponent(value.trim())}`);
      setDet(d);
      if (d.imap_host) setForm((f) => ({ ...f, imap_host: d.imap_host!, imap_port: d.imap_port ?? 993, smtp_host: d.smtp_host!, smtp_port: d.smtp_port ?? 465, smtp_security: d.smtp_security ?? "ssl" }));
      setShowServers(d.kind === "guess");
    } catch { setDet(null); } finally { setChecking(false); }
  };
  useEffect(() => { const t = window.setTimeout(() => void detect(email), 500); return () => window.clearTimeout(t); }, [email]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (ON_MAC && !form.password.trim()) return;
    if (!form.password.trim() || form.imap_host.trim().length < 3 || form.smtp_host.trim().length < 3) {
      setError("Wait until the address is recognised, then paste the password.");
      return;
    }
    setBusy(true); setError("");
    const username = form.username || email.trim();
    try {
      await api("/mail/accounts", { body: { ...form, name: form.name || email.split("@")[0], email: email.trim(), username } });
      let calNote = "";
      if (addCal && det?.caldav_url) {
        try {
          const found = await api<{ name: string; url: string }[]>("/calendars/discover", { body: { url: det.caldav_url, username, password: form.password } });
          // no colour sent: the app gives a new calendar its default colour
          for (const c of found.slice(0, 8)) await api("/calendars", { body: { name: c.name, kind: "caldav", url: c.url, username, password: form.password } });
          calNote = found.length ? ` and ${found.length} calendar${found.length === 1 ? "" : "s"}` : "";
        } catch { calNote = " (calendar couldn't be found; add it later from the Calendar page)"; }
      }
      toast.ok(`Mail connected${calNote}`);
      setForm({ ...form, password: "" });
      setConnected({ email: email.trim(), calendar: det?.calendar_help ?? null });
      setDet(null); setEmail("");
      onAdded();
    } catch (err) { setError(plainError(err)); } finally { setBusy(false); }
  };

  return (
    <form ref={formRef} className="cmc-other" onSubmit={submit}>
      <div className="cmc-other-head">
        <Mail size={15} aria-hidden="true" />
        <h3 className="cmc-sub">{plain ? "Type your email address" : "Your email"}</h3>
        <span className="cmc-small cmc-muted">{plain ? "Gmail, iCloud, Yahoo, Fastmail, AOL, Zoho, your own domain…" : "Gmail, Outlook, iCloud, Yahoo, and the rest"}</span>
      </div>
      <Input required type="email" autoFocus placeholder="Your email address" aria-label="Your email address" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => void detect()} />
      {checking && <Busy>Looking up {email.split("@")[1] || "that address"}…</Busy>}
      {det?.kind === "one_click" && (
        <Notice actions={<>
          <Button size="sm" variant="primary" onClick={() => onSuggest(det.provider!, email.trim())}>Connect {NAMES[det.provider!]}</Button>
          {det.fallback && <Button size="sm" variant="ghost" onClick={() => setDet(det.fallback!)}>Use an app password instead</Button>}
        </>}>
          <p className="cmc-row"><ProviderLogo provider={det.provider!} /><span>{det.workspace ? `${email.split("@")[1]} uses ${det.provider === "google" ? "Google Workspace" : "Microsoft 365"}.` : `That's a ${NAMES[det.provider!]} address.`} One click is easier, with no app password.</span></p>
        </Notice>
      )}
      {det?.kind === "invalid" && email.includes("@") && <Notice tone="danger">{det.message}</Notice>}
      {det?.kind === "unavailable" && (
        <Notice title={<span className="cmc-row"><ProviderLogo provider={det.provider!} />{det.label}</span>}>
          <p>{det.message}</p>
          {det.mac
            ? <MacSignIn email={email.trim()} who={signer(det)} onAdded={() => { setDet(null); setEmail(""); onAdded(); }} />
            : det.steps && <Steps items={det.steps} />}
          {det.mac && det.steps && (
            <Disclosure summary="Only want your Outlook calendar?">
              <Steps items={det.steps} />
              <Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/calendar">Open Calendar</Link>
            </Disclosure>
          )}
          {!det.mac && <p><Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/calendar">Open Calendar</Link></p>}
        </Notice>
      )}
      {connected && (
        <Notice tone="ok" title={`${connected.email} is connected.`} actions={<IconButton label="Close" size="sm" onClick={() => setConnected(null)}><X size={13} /></IconButton>}>
          {connected.calendar && (
            <>
              <p>Want your calendar too? It takes three steps:</p>
              <Steps items={connected.calendar} />
              <p className="cmc-row cmc-wrap"><a className="ui-btn ui-btn-secondary ui-btn-sm" href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noreferrer">Open Google Calendar settings <ExternalLink size={12} aria-hidden="true" /></a>
                <Link className="ui-btn ui-btn-ghost ui-btn-sm" to="/calendar">Go to the Calendar page</Link></p>
            </>
          )}
        </Notice>
      )}
      {ON_MAC && det && det.kind !== "one_click" && det.kind !== "invalid" && det.kind !== "unavailable" && (
        <MacSignIn email={email.trim()} who={signer(det)} onAdded={() => { setDet(null); setEmail(""); onAdded(); }} />
      )}
      {det && det.app_password && det.app_password_url && det.kind !== "one_click" && det.kind !== "unavailable" && (
        <PasswordShell mac={ON_MAC}>
          <div className="cmc-stack">
            <p className="cmc-small cmc-muted">{brand(det)} needs an <strong>app password</strong>: a separate password just for this app. About a minute.</p>
            <div className="cmc-step">
              <span className="cmc-step-num" aria-hidden="true">1</span>
              <div className="cmc-stack cmc-grow">
                <a className="ui-btn ui-btn-primary cmc-self-start" href={det.app_password_url} target="_blank" rel="noreferrer">Open {owner(det)}'s app password page <ExternalLink size={13} aria-hidden="true" /></a>
                {det.steps && <ul className="cmc-bullets">{det.steps.map((x) => <li key={x}>{x.replace(/,? and paste it here\.?$/i, ".")}</li>)}</ul>}
              </div>
            </div>
            <div className="cmc-step">
              <span className="cmc-step-num" aria-hidden="true">2</span>
              <div className="cmc-stack cmc-grow">
                <strong className="cmc-small">Paste the app password here</strong>
                <div className="cmc-row">
                  <Input className="cmc-grow cmc-mono" type="password" autoComplete="off" placeholder="Paste it here" aria-label="App password" value={form.password}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm({ ...form, password: v });
                      // a full app password (16 letters, any spaces or dashes) connects straight away
                      if (v.replace(/[\s-]/g, "").length === 16 && form.imap_host && !busy) window.setTimeout(() => void submit(), 50);
                    }} />
                  <Button variant="primary" busy={busy} disabled={!form.password} onClick={() => void submit()}>{busy ? "Connecting…" : "Connect"}</Button>
                </div>
                {busy && <Busy>Checking it with {brand(det)}…</Busy>}
              </div>
            </div>
            {error && <ErrorState title="That did not connect" line={error} />}
            <Disclosure summary="More options" open={showServers} onToggle={setShowServers}>
              <div className="cmc-stack">
                <Input placeholder="Your name on sent mail (optional)" aria-label="Your name on sent mail" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                {det.caldav_url && <CheckField checked={addCal} onChange={setAddCal}>Also add my calendars</CheckField>}
                {det.username_hint && <p className="cmc-small cmc-muted">{det.username_hint}</p>}
                <Input placeholder="Username (defaults to your email)" aria-label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
            </Disclosure>
          </div>
        </PasswordShell>
      )}
      {det && !(det.app_password && det.app_password_url) && det.kind !== "one_click" && det.kind !== "invalid" && det.kind !== "unavailable" && (
        <PasswordShell mac={ON_MAC}>
          <div className="cmc-stack">
            {det.one_click_unavailable && <p className="cmc-small cmc-muted">{det.one_click_unavailable === "google" ? "Gmail" : NAMES[det.one_click_unavailable]} connects with an app password: a special password just for this app. It takes about a minute.</p>}
            <p className="cmc-small"><strong>{det.label}</strong>{det.source === "guess" ? " · best guess" : det.source === "ispdb" ? " · settings found automatically" : ""}</p>
            {det.steps && (
              <div className="cmc-small">
                {det.app_password ? <p>This provider needs an <strong>app password</strong> (not your normal password):</p> : null}
                <Steps items={det.steps} />
                {det.app_password_url && <a className="cmc-link" href={det.app_password_url} target="_blank" rel="noreferrer">Open the app password page <ExternalLink size={12} aria-hidden="true" /></a>}
              </div>
            )}
            <div className="cmc-pair">
              <Input placeholder="Your name (shown on sent mail)" aria-label="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Input type="password" autoComplete="off" placeholder={det.app_password ? "App password" : "Password"} aria-label={det.app_password ? "App password" : "Password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            {det.caldav_url && <CheckField checked={addCal} onChange={setAddCal}>Also add my calendars</CheckField>}
            <Disclosure summary={`Server settings${det.username_hint ? " and username" : ""}`} open={showServers} onToggle={setShowServers}>
              <div className="cmc-stack">
                {det.username_hint && <p className="cmc-small cmc-muted">{det.username_hint}</p>}
                <Input placeholder="Username (defaults to your email)" aria-label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                <div className="cmc-servers">
                  <Input placeholder="Incoming mail server" aria-label="Incoming mail server" value={form.imap_host} onChange={(e) => setForm({ ...form, imap_host: e.target.value })} />
                  <Input className="cmc-port" type="number" aria-label="Incoming port" value={form.imap_port} onChange={(e) => setForm({ ...form, imap_port: Number(e.target.value) })} />
                  <Input placeholder="Outgoing mail server" aria-label="Outgoing mail server" value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} />
                  <Input className="cmc-port" type="number" aria-label="Outgoing port" value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })} />
                  <Select aria-label="Outgoing security" value={form.smtp_security} onChange={(e) => setForm({ ...form, smtp_security: e.target.value as "ssl" | "starttls" })}><option value="ssl">SSL</option><option value="starttls">STARTTLS</option></Select>
                </div>
              </div>
            </Disclosure>
            {error && <ErrorState title="That did not connect" line={error} />}
            <Button variant="primary" className="cmc-self-start" busy={busy} disabled={!form.password} onClick={() => void submit()}>{busy ? "Testing…" : "Test and connect"}</Button>
          </div>
        </PasswordShell>
      )}
    </form>
  );
}

function OwnRegistration({ providers, onSaved }: { providers: Record<Provider, ProviderInfo> | null; onSaved: () => void }) {
  const [p, setP] = useState<Provider>("google");
  const [form, setForm] = useState({ client_id: "", client_secret: "", tenant: "common" });
  const toast = useToast();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/connect/${p}/client`, { method: "PUT", body: p === "google" ? { client_id: form.client_id, client_secret: form.client_secret } : { client_id: form.client_id, tenant: form.tenant } });
      toast.ok(form.client_id ? `Saved. Connect ${NAMES[p]} now uses your registration.` : "Back to the built-in registration.");
      setForm({ client_id: "", client_secret: "", tenant: "common" });
      onSaved();
    } catch (err) { toast.err(err); }
  };
  const info = providers?.[p];
  return (
    <Disclosure id="own-registration" summary="Advanced: set up Google and Microsoft sign-in (one time, for whoever runs this app)">
      <form className="cmc-stack" onSubmit={save}>
        <Tabs label="Company" size="sm" value={p} onChange={(k) => setP(k as Provider)} items={(["google", "microsoft"] as Provider[]).map((k) => ({ id: k, label: NAMES[k] }))} />
        <p className="cmc-small cmc-muted">
          {p === "google"
            ? "Create a Desktop app OAuth client in Google Cloud Console (APIs & Services > Credentials), enable the Gmail and Google Calendar APIs, and add yourself as a test user. Paste the client ID and its client secret."
            : "Register an app in the Microsoft Entra admin center (App registrations), add the Mobile and desktop platform with redirect URI http://localhost, and turn on Allow public client flows. No secret is needed."}
          {" "}Steps: <span className="cmc-mono">docs/connect-google-microsoft.md</span>.
          {info && <> Currently: {info.source === "none" ? "not set up" : `${info.source} (${info.client_id_hint})`}.</>}
        </p>
        <Input className="cmc-mono" aria-label="Client ID" placeholder={p === "google" ? "1234-abc.apps.googleusercontent.com" : "Application (client) ID"} value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
        {p === "google" && <Input className="cmc-mono" type="password" autoComplete="off" aria-label="Client secret" placeholder="Client secret (GOCSPX-…)" value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} />}
        {p === "microsoft" && <Input className="cmc-mono" aria-label="Tenant" placeholder="Tenant: common, consumers, organizations or your tenant ID" value={form.tenant} onChange={(e) => setForm({ ...form, tenant: e.target.value })} />}
        <div><Button type="submit" size="sm">{form.client_id ? "Save registration" : "Use the built-in one"}</Button></div>
      </form>
    </Disclosure>
  );
}
