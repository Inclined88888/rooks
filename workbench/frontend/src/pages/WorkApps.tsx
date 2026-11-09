import { AlertTriangle, Copy, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { openExternal } from "../desktop";
import { Badge, Button, ErrorState, Loading, Page, Section, useToast } from "../ui";
import { Disclosure, Notice, plainError } from "./day/parts";
import { ProviderLogo } from "./day/logos";
import "./settings/settings.css";

/**
 * Work apps (design 0012): one work account, Microsoft 365 or Google Workspace, and one switch per thing Rooks may do
 * there. Each switch asks the company's sign-in only for its own permissions when it is turned on. The switches,
 * what each allows and their states come from the app (/api/work/status), the same words the terminal's /work prints.
 */
type Feature = { id: string; label: string; says: string; asks_first: boolean; state: "on" | "off" | "signin" | "waiting"; state_words: string; waiting_words?: string };
type Suite = "microsoft" | "google";
/** Each suite's own words, from the app (work_suite.NAMES): the same the terminal's /work says. */
export type SuiteNames = { suite: string; company: string; files: string; home: string; sites: string; site: string; chats: string; meetings: string; tasks: string; upload_to: string };
type WorkStatus = {
  account: { provider: Suite; email: string; name: string; status: string; needs_sign_in: boolean } | null;
  suites: Record<Suite, { ready: boolean; words: string }>;
  names: SuiteNames;
  features: Feature[];
  words?: { asks_first?: string };
  advanced: Advanced;
};
type Started = { url: string; state: string; opened: boolean };
type Switched = { id: string; state: string; url?: string; attempt?: string; opened?: boolean };
type Attempt = { status: string; error?: string };

const TONE: Record<Feature["state"], "ok" | "neutral" | "warn"> = { on: "ok", off: "neutral", signin: "warn", waiting: "warn" };

export default function WorkApps() {
  const [st, setSt] = useState<WorkStatus | null>(null);
  const [problem, setProblem] = useState("");
  const [waiting, setWaiting] = useState("");  // which switch (or "account") is waiting for the sign-in in the browser
  const [error, setError] = useState("");
  const timer = useRef<number>();
  const toast = useToast();

  const load = useCallback(() => api<WorkStatus>("/work/status").then((s) => { setSt(s); setProblem(""); })
    .catch((e) => setProblem(plainError(e, "Work apps did not load."))), []);
  useEffect(() => { void load(); return () => window.clearInterval(timer.current); }, [load]);

  /** The sign-in opens in the person's own browser; this page waits for it to finish. */
  const follow = (attempt: string, what: string) => {
    setWaiting(what);
    window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      const a = await api<Attempt>(`/connect/status/${attempt}`).catch(() => null);
      if (!a || a.status === "pending") return;
      window.clearInterval(timer.current);
      setWaiting("");
      if (a.status === "failed" || a.status === "unknown") setError(a.error || "That sign-in did not finish. Try again.");
      void load();
    }, 1500);
  };

  const connect = async (provider: Suite) => {
    setError("");
    try {
      const r = await api<Started>(`/work/connect/${provider}`, { body: {} });
      if (!r.opened) void openExternal(r.url);
      follow(r.state, provider === "google" ? "account-google" : "account");
    } catch (e) { setError(plainError(e)); }
  };

  const toggle = async (f: Feature, on: boolean) => {
    setError("");
    try {
      const r = await api<Switched>(`/work/features/${f.id}`, { body: { on } });
      if (r.url && r.attempt) { if (!r.opened) void openExternal(r.url); follow(r.attempt, f.id); return; }
      void load();
    } catch (e) { setError(plainError(e)); }
  };

  const copyNote = async (f: Feature) => {
    try {
      const r = await api<{ note: string }>(`/work/features/${f.id}/it-note`);
      await navigator.clipboard.writeText(r.note);
      toast.ok("Copied. Paste it into a message to your IT team.");
    } catch (e) { toast.err(e); }
  };

  const disconnect = async () => {
    if (!st?.account || !confirm(`Disconnect ${st.account.email}? Rooks stops reaching your work files, chats and tasks. Nothing is deleted at ${st.names.company}.`)) return;
    try { const r = await api<{ note: string }>("/work/account", { method: "DELETE" }); toast.ok(r.note); void load(); } catch (e) { toast.err(e); }
  };

  const asksFirst = st?.words?.asks_first ?? "Rooks always asks you first";
  const acct = st?.account;
  const names = st?.names;
  const removeAt = acct?.provider === "google"
    ? "To also remove the permission at Google, open your Google Account, Security, Your connections to third-party apps, and remove Rooks."
    : "To also remove the permission at Microsoft, open your account's apps page (My Apps) and remove Rooks.";

  return (
    <Page title="Work apps" className="st-page"
      description="Your company's Microsoft 365 (Outlook, Teams, OneDrive, SharePoint, Planner and To Do) or Google Workspace (Gmail, Google Chat, Drive, Docs, Sheets, Meet and Tasks). Rooks asks for each part only when you turn it on.">
      {st === null && !problem && <Loading rows={4} label="Loading work apps" />}
      {problem && <ErrorState title="Work apps did not load" line={problem} onRetry={() => void load()} />}
      {error && <Notice tone="danger" title="That did not work">{error}</Notice>}
      {st && (
        <>
          <Section title="Your work account">
            {acct ? (
              <div className="st-group">
                <div className="st-row">
                  <div className="st-row-text">
                    <span className="st-row-label"><span className="st-inline"><ProviderLogo provider={acct.provider} /> Signed in as {acct.email}</span></span>
                    <span className="st-row-help">{names?.suite}. Everything runs on this computer.</span>
                  </div>
                  <div className="st-row-control">
                    {acct.needs_sign_in && <Button size="sm" icon={<AlertTriangle size={13} />} onClick={() => void connect(acct.provider)}>Sign in again</Button>}
                    <Button size="sm" variant="ghost" icon={<LogOut size={14} />} onClick={() => void disconnect()}>Disconnect</Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="st-stack">
                <p className="st-p">Sign in with the account your company gave you. The first sign-in only tells Rooks who you are.</p>
                <div className="st-inline">
                  <Button variant="primary" icon={<ProviderLogo provider="microsoft" />} disabled={!st.suites.microsoft.ready || !!waiting}
                    onClick={() => void connect("microsoft")}>{waiting === "account" ? "Finish signing in, in your browser…" : "Microsoft 365"}</Button>
                  <Button icon={<ProviderLogo provider="google" />} disabled={!st.suites.google.ready || !!waiting}
                    onClick={() => void connect("google")}>{waiting === "account-google" ? "Finish signing in, in your browser…" : "Google Workspace"}</Button>
                </div>
                {!st.suites.microsoft.ready && <p className="st-small">{st.suites.microsoft.words}</p>}
                {!st.suites.google.ready && <p className="st-small">{st.suites.google.words}</p>}
              </div>
            )}
          </Section>

          <Section title="What Rooks may do" description={acct ? "Turn on only what you need. Anything that sends, posts, shares or changes something waits for your yes in Needs you." : "Connect your work account first."}>
            <div className="st-group">
              {st.features.map((f) => (
                <div key={f.id} className="st-row">
                  <div className="st-row-text">
                    <span className="st-row-label">{f.label}</span>
                    <span className="st-row-help">{f.says}{f.asks_first ? ` ${asksFirst}.` : ""}</span>
                    {f.state === "waiting" && f.waiting_words && <span className="st-row-help">{f.waiting_words}</span>}
                  </div>
                  <div className="st-row-control">
                    <Badge tone={TONE[f.state]}>{waiting === f.id ? "Finish signing in, in your browser" : f.state_words}</Badge>
                    {f.state === "waiting" && <Button size="sm" icon={<Copy size={13} />} onClick={() => void copyNote(f)}>Copy the request for IT</Button>}
                    {acct && (f.state === "on"
                      ? <Button size="sm" onClick={() => void toggle(f, false)}>Turn off</Button>
                      : <Button size="sm" variant="primary" disabled={!!waiting} onClick={() => void toggle(f, true)}>{f.state === "signin" ? "Sign in" : f.state === "waiting" ? "Try again" : "Turn on"}</Button>)}
                  </div>
                </div>
              ))}
            </div>
            <p className="st-small">Turning something off stops it here at once. {removeAt}</p>
          </Section>

          <Disclosure summary="Advanced">
            <div className="st-stack">
              <p className="st-small">Company (tenant): <span className="st-mono">{st.advanced.tenant || "not signed in"}</span></p>
              <p className="st-small">App registration: <span className="st-mono">{st.advanced.client_id_hint || "not set up"}</span></p>
              <p className="st-small">Allowed now: <span className="st-mono">{st.advanced.granted.join(" ") || "nothing yet"}</span></p>
              {Object.entries(st.advanced.permissions).map(([id, perms]) => (
                <p key={id} className="st-small">{st.features.find((f) => f.id === id)?.label}: <span className="st-mono">{perms.join(" ")}</span></p>
              ))}
              {st.advanced.admin_consent && <p className="st-small">Approval address for an IT admin: <span className="st-mono">{st.advanced.admin_consent}</span></p>}
            </div>
          </Disclosure>
        </>
      )}
    </Page>
  );
}

/** Only for the Advanced part of the page. */
type Advanced = { tenant: string; client_id_hint: string; granted: string[]; permissions: Record<string, string[]>; admin_consent: string };
