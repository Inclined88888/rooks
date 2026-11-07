// "Your plan": sign in to AI Workspace (optional), see what's unlocked, upgrade, buy credits, manage billing.
import { Apple, Check, CreditCard, Lock, LogOut, Mail, RefreshCw, Users } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Account, Product, acceptInvite, billingPortal, checkout, enterCode, openExternal, pollSignIn, providers, refreshAccount, signOut,
  skipSetup, startEmail, startOAuth, teamCheckout, useAccount,
} from "../account";
import { Badge, Button, ErrorState, Input, Loading, Page, Section } from "../ui";
import { Advanced, AuthCard, Notice, SettingRow, SettingsGroup } from "./settings";

const PLANS = [
  { id: "free", name: "Free", price: "A$0", blurb: "The whole app with your own keys or Ollama. Forever." },
  { id: "pro", name: "Pro", price: "A$19/mo", blurb: "Cloud models with no setup, computer use, watchers, learning and phone sync." },
  { id: "team", name: "Team", price: "A$29/seat/mo", blurb: "Pro for everyone, plus shared skills and admin controls." },
  { id: "business", name: "Business", price: "A$49/seat/mo", blurb: "Team plus SSO, audit export and priority support." },
];
const CREDITS: { id: Product; label: string }[] = [
  { id: "credits_small", label: "5,000 credits" },
  { id: "credits_medium", label: "15,000 credits" },
  { id: "credits_large", label: "50,000 credits" },
];

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Email link or 6-digit code, plus Google and Apple when the server has them. Used by the page and the setup step. */
export function SignIn({ onSignedIn }: { onSignedIn?: (a: Account) => void }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [social, setSocial] = useState({ google: false, apple: false });
  const polling = useRef<number>();
  useEffect(() => { providers().then(setSocial).catch(() => undefined); }, []);
  useEffect(() => () => window.clearInterval(polling.current), []);

  const poll = () => {
    window.clearInterval(polling.current);
    polling.current = window.setInterval(() => {
      pollSignIn().then((r) => {
        if (r.status === "approved" && r.account) { window.clearInterval(polling.current); onSignedIn?.(r.account); }
        if (r.status === "expired") { window.clearInterval(polling.current); setErr("That sign-in expired. Start again."); setSent(false); }
      }).catch(() => undefined);
    }, 2500);
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await startEmail(email); setSent(true); poll(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { const a = await enterCode(code); window.clearInterval(polling.current); onSignedIn?.(a); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const oauth = async (p: "google" | "apple") => {
    setErr("");
    try { const { url } = await startOAuth(p); openExternal(url); poll(); } catch (x) { setErr(errText(x)); }
  };

  return (
    <div className="st-stack">
      {!sent ? (
        <form className="st-form" onSubmit={send}>
          <Input label="Email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <Button type="submit" variant="primary" icon={<Mail size={14} />} busy={busy} disabled={!email}>{busy ? "Sending…" : "Email me a sign-in link"}</Button>
        </form>
      ) : (
        <form className="st-form" onSubmit={verify}>
          <p className="st-p">We sent a link and a 6-digit code to <strong>{email}</strong>. Click the link, or type the code here.</p>
          <Input label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" />
          <div className="st-form-actions">
            <Button type="submit" variant="primary" icon={<Check size={14} />} busy={busy} disabled={code.length < 6}>{busy ? "Checking…" : "Sign in"}</Button>
            <Button variant="ghost" onClick={() => { setSent(false); setCode(""); window.clearInterval(polling.current); }}>Use another email</Button>
          </div>
        </form>
      )}
      {(social.google || social.apple) && (
        <div className="st-form-actions">
          {social.google && <Button onClick={() => oauth("google")}>Continue with Google</Button>}
          {social.apple && <Button icon={<Apple size={14} />} onClick={() => oauth("apple")}>Continue with Apple</Button>}
        </div>
      )}
      {err && <Notice tone="danger">{err}</Notice>}
    </div>
  );
}

/** Shown once after first-run setup when accounts are switched on. Skipping keeps the free app as it is. */
export function AccountSetup({ onDone }: { onDone: () => void }) {
  const finish = () => { skipSetup().catch(() => undefined).finally(onDone); };
  return (
    <AuthCard step="Optional" title="Sign in to Rooks"
      line="Free works without an account. Sign in to use Pro: cloud models with no setup, computer use, website watchers, learning from a demo and phone sync.">
      <SignIn onSignedIn={finish} />
      <Button variant="ghost" className="st-auth-full" onClick={finish}>Skip, use Free</Button>
    </AuthCard>
  );
}

export default function Plan() {
  const [account, reload] = useAccount();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [failed, setFailed] = useState(false);
  const [invite, setInvite] = useState("");
  const [teamName, setTeamName] = useState("");
  const [seats, setSeats] = useState(3);
  const wanted = params.get("feature");

  const retry = useCallback(() => { setFailed(false); reload().then((a) => { if (!a) setFailed(true); }); }, [reload]);
  useEffect(() => {
    if (account) return;
    const t = window.setTimeout(() => { reload().then((a) => { if (!a) setFailed(true); }); }, 1500);
    return () => window.clearTimeout(t);
  }, [account, reload]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr("");
    try { await fn(); } catch (x) { setErr(errText(x)); } finally { setBusy(""); }
  };
  const buy = (p: Product) => run(p, async () => openExternal((await checkout(p)).url));

  if (!account) {
    return (
      <Page title="Your plan" description="Free is the whole app with your own keys or Ollama. Pro adds the things that need our servers." className="st-page">
        {failed ? <ErrorState title="Your plan did not load" line="The app did not answer. Try again in a moment." onRetry={retry} /> : <Loading rows={3} label="Loading your plan" />}
      </Page>
    );
  }
  const paid = account.plan !== "free";

  return (
    <Page title="Your plan" description="Free is the whole app with your own keys or Ollama. Pro adds the things that need our servers." className="st-page"
      actions={account.signed_in ? <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} busy={busy === "refresh"} onClick={() => run("refresh", refreshAccount)}>{busy === "refresh" ? "Checking…" : "Check again"}</Button> : undefined}>
      <div className="st-stack st-gap-b">
        {!account.cloud_configured && <Notice>Accounts aren't switched on in this build yet, so every Pro feature is unlocked while in beta.</Notice>}
        {account.cloud_configured && !account.billing_live && <Notice>Pro features are free while in beta. Sign in now and your plan carries over.</Notice>}
        {wanted && account.billing_live && !account.features.includes(wanted) && (
          <Notice><Lock size={14} /> {account.pro_features.find((f) => f.id === wanted)?.label ?? "That feature"} needs Pro.</Notice>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
      </div>

      <Section title={account.plan_name} actions={paid ? <Badge tone={account.status === "past_due" ? "warn" : "ok"}>{account.status === "past_due" ? "Payment due" : "Active"}</Badge> : undefined}>
        {account.signed_in ? (
          <SettingsGroup>
            <SettingRow label="Signed in" help={account.email}>
              {paid && <Button size="sm" icon={<CreditCard size={14} />} onClick={() => run("portal", async () => openExternal((await billingPortal()).url))}>Manage billing</Button>}
              <Button size="sm" variant="ghost" icon={<LogOut size={14} />} onClick={() => run("out", signOut)}>Sign out</Button>
            </SettingRow>
            {account.team && <SettingRow label="Team" help={`${account.team.name} (${account.team.role})`}><Users size={14} aria-hidden="true" /></SettingRow>}
            {account.credits != null && <SettingRow label="Cloud model credits" help={`${account.credits.toLocaleString()} left`} />}
            {account.renews_at && <SettingRow label="Renews" help={new Date(account.renews_at).toLocaleDateString()} />}
            {account.offline_until && <SettingRow label="Works offline until" help={new Date(account.offline_until * 1000).toLocaleDateString()} />}
          </SettingsGroup>
        ) : account.cloud_configured ? (
          <SettingsGroup><div className="st-row"><div className="st-grow"><SignIn onSignedIn={() => reload()} /></div></div></SettingsGroup>
        ) : (
          <p className="st-p">The whole app with your own keys or Ollama, no account needed. Every feature below works in this build.</p>
        )}
      </Section>

      <Section title="What's included">
        <ul className="st-checks">
          {["Your own keys and Ollama", "Every Free feature, always"].map((l) => <li key={l}><Check size={14} /> {l}</li>)}
          {account.pro_features.map((f) => (
            <li key={f.id} className={f.unlocked ? "" : "is-locked"}>{f.unlocked ? <Check size={14} /> : <Lock size={14} />} {f.label}</li>
          ))}
        </ul>
      </Section>

      {account.signed_in && (
        <>
          <Section title="Plans">
            <div className="st-plans">
              {PLANS.filter((p) => p.id === "free" || p.id === "pro").map((p) => (
                <div key={p.id} className={`st-plan-card${account.plan === p.id ? " is-current" : ""}`}>
                  <div className="st-plan-card-head"><span className="st-plan-card-name">{p.name}</span><span className="st-plan-card-price">{p.price}</span></div>
                  <p className="st-small">{p.blurb}</p>
                  {p.id === "pro" && account.plan === "free" && (
                    <div className="st-form-actions">
                      <Button variant="primary" disabled={!!busy} busy={busy === "pro_monthly"} onClick={() => buy("pro_monthly")}>{busy === "pro_monthly" ? "Opening…" : "Upgrade monthly"}</Button>
                      <Button disabled={!!busy} onClick={() => buy("pro_yearly")}>Yearly (save 2 months)</Button>
                    </div>
                  )}
                  {account.plan === p.id && <div><Badge tone="ok">Your plan</Badge></div>}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Teams and credits">
            <Advanced label="Team plans, credits, and invites">
              <div className="st-plans">
                {PLANS.filter((p) => p.id === "team" || p.id === "business").map((p) => (
                  <div key={p.id} className={`st-plan-card${account.plan === p.id ? " is-current" : ""}`}>
                    <div className="st-plan-card-head"><span className="st-plan-card-name">{p.name}</span><span className="st-plan-card-price">{p.price}</span></div>
                    <p className="st-small">{p.blurb}</p>
                    {account.plan !== p.id ? (
                      <div className="st-form">
                        <div className="st-key">
                          <Input placeholder="Team name" aria-label="Team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
                          <Input className="st-seats" type="number" min={1} max={500} value={seats} onChange={(e) => setSeats(Number(e.target.value) || 1)} aria-label="Seats" />
                        </div>
                        <div><Button icon={<Users size={14} />} disabled={!!busy || !teamName.trim()}
                          onClick={() => run(p.id, async () => openExternal((await teamCheckout(teamName, seats, p.id === "team" ? "team_monthly" : "business_monthly")).url))}>Start {p.name}</Button></div>
                      </div>
                    ) : <div><Badge tone="ok">Your plan</Badge></div>}
                  </div>
                ))}
                <div className="st-plan-card">
                  <div className="st-plan-card-head"><span className="st-plan-card-name">Cloud model credits</span></div>
                  <p className="st-small">Pro includes 5,000 a month. Top up any time; top-ups never expire.</p>
                  <div className="st-form-actions">
                    {CREDITS.map((c) => <Button key={c.id} size="sm" disabled={!!busy} onClick={() => buy(c.id)}>{c.label}</Button>)}
                  </div>
                </div>
                <form className="st-plan-card" onSubmit={(e) => { e.preventDefault(); run("invite", () => acceptInvite(invite)); }}>
                  <div className="st-plan-card-head"><span className="st-plan-card-name">Join a team</span></div>
                  <p className="st-small">Paste the invite code from your email.</p>
                  <div className="st-key">
                    <Input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Invite code" aria-label="Invite code" />
                    <Button type="submit" disabled={!!busy || invite.trim().length < 8}>Join</Button>
                  </div>
                </form>
              </div>
            </Advanced>
          </Section>
        </>
      )}
    </Page>
  );
}
