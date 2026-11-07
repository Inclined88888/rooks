import { ArrowRight, Check, Download, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { BrandMark, Brand } from "../brand";
import { Badge, Button, Input, Loading } from "../ui";
import { ButtonLink, Notice } from "./settings/index";

const MARK: Record<"claude" | "codex" | "copilot", Brand | null> = { claude: "claude", codex: "chatgpt", copilot: null };

type PlanState = { installed: boolean; signed_in: boolean; account: string; can_install: boolean; connected: boolean; name: string; terms: string; quota?: string };
type SignIn = { id: string; status: string; url: string; code: string; needs_code: boolean; error: string };

/** A plan through the vendor's own app (Claude Code, Codex), all from here: install, sign in, start chatting. No terminal. */
export default function PlanCard({ agent, title, blurb, onConnected, cta = "Start chatting", nested }: {
  agent: "claude" | "codex" | "copilot"; title: string; blurb: string; onConnected: () => Promise<void> | void; cta?: string; nested?: boolean;
}) {
  const [st, setSt] = useState<PlanState | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [signin, setSignin] = useState<SignIn | null>(null);
  const [code, setCode] = useState("");
  const timer = useRef<number>();
  const load = useCallback(async () => {
    try { setSt((await api<Record<string, PlanState>>("/plans"))[agent]); } catch (e) { setError((e as Error).message); }
  }, [agent]);
  useEffect(() => { load(); return () => window.clearInterval(timer.current); }, [load]);
  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };
  const install = () => act("Installing… this takes about a minute", async () => {
    setSt(await api<PlanState>(`/plans/${agent}/install`, { method: "POST" }));
  });
  const start = () => act("Opening the sign-in…", async () => {
    const s = await api<SignIn>(`/plans/${agent}/signin`, { method: "POST" });
    setSignin(s);
    if (s.url) window.open(s.url, "_blank", "noopener");
    window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      const n = await api<SignIn>(`/plans/signin/${s.id}`).catch(() => null);
      if (n) setSignin(n);
      if (!n || (n.status !== "waiting" && n.status !== "starting")) { window.clearInterval(timer.current); load(); }
    }, 2000);
  });
  const sendCode = () => act("Finishing…", async () => {
    const n = await api<SignIn>(`/plans/signin/${signin!.id}/code`, { body: { code: code.trim() } });
    setSignin(n);
    if (n.status === "failed") throw new Error(n.error || "That code didn't work. Press Sign in again and copy the newest code.");
    await load();
  });
  const go = () => act("Connecting…", async () => {
    await api(`/plans/${agent}/connect`, { method: "POST" });
    await onConnected();
  });

  const mark = MARK[agent];
  return (
    <div className={`st-plan${nested ? " is-nested" : ""}`}>
      <div className="st-plan-head">
        {mark && <BrandMark name={mark} />}<span className="st-plan-name">{title}</span>
        {st?.signed_in && <Badge tone="ok"><Check size={11} /> Signed in</Badge>}
      </div>
      <p className="st-small">{blurb} {st && <a className="st-link" href={st.terms} target="_blank" rel="noreferrer">Terms</a>}</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {!st ? (error ? null : <Loading rows={1} label={`Checking ${title}`} />) : busy ? (
        <p className="st-small" role="status">{busy}</p>
      ) : !st.installed ? (
        st.can_install ? (
          <div><Button variant="primary" icon={<Download size={15} />} onClick={install}>Set up {st.name}</Button></div>
        ) : (
          <div className="st-stack">
            <p className="st-small">This needs Node.js first. It's free and installs like any other app.</p>
            <div className="st-inline">
              <ButtonLink size="sm" href="https://nodejs.org/en/download" icon={<ExternalLink size={12} />}>Get Node.js</ButtonLink>
              <Button variant="ghost" size="sm" onClick={load}>I've installed it</Button>
            </div>
          </div>
        )
      ) : st.signed_in ? (
        <div className="st-inline">
          <span className="st-grow st-small">{st.account ? `Signed in as ${st.account}` : `Signed in with your ${st.name} plan`}{st.quota ? ` · ${st.quota}` : null}</span>
          <Button variant="primary" onClick={go}>{cta} <ArrowRight size={16} /></Button>
        </div>
      ) : signin && signin.status === "waiting" ? (
        <div className="st-stack">
          {signin.needs_code ? (
            <>
              <ol className="st-ol"><li>Sign in on the page that just opened.</li><li>Copy the code it shows you.</li><li>Paste it here.</li></ol>
              <div className="st-key">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" autoFocus aria-label="Sign-in code" />
                <Button variant="primary" disabled={code.trim().length < 4} onClick={sendCode}>Finish</Button>
              </div>
            </>
          ) : (
            <>
              <p className="st-p">Sign in on the page that just opened and type this code:</p>
              <div className="st-code" aria-label="One-time code">{signin.code}</div>
              <p className="st-small" role="status">Waiting for you to approve it…</p>
            </>
          )}
          <div><ButtonLink href={signin.url} variant="ghost" size="sm">Open the sign-in page again</ButtonLink></div>
        </div>
      ) : (
        <div className="st-stack">
          {signin?.status === "failed" && <Notice tone="danger">{signin.error || "Sign-in didn't finish. Try again."}</Notice>}
          <div><Button variant="primary" onClick={start}>Sign in with {st.name}</Button></div>
        </div>
      )}
    </div>
  );
}
