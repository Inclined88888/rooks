import { ArrowRight, Check, ClipboardPaste, ExternalLink, ShieldCheck } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { BrandMark } from "../brand";
import { Badge, Button, Input, Loading } from "../ui";
import PlanCard from "./PlanCard";
import { Advanced, ButtonLink, Choice, Notice } from "./settings/index";

/** Connecting a model without jargon, shared by the first-run welcome and Settings: sign in with a plan you already
 * pay for (ChatGPT, Claude), or paste a key and the provider is recognised from it. */

export type Preset = { name: string; auth_kind: string; protocol: string; base_url: string; note?: string };
export type KeyInfo = { url: string; prefix: string; free?: boolean; limits?: string };
export type Validation = { ok: boolean; preset: string; name: string; detail: string; health: string };
export type Sub = { id: string; name: string; plans: string; available: boolean; detail: string; source: string; via?: string };
export const KEY_ORDER = ["openai", "anthropic", "xai", "gemini", "groq", "openrouter", "mistral", "deepseek", "compatible"];

/** Paste box that recognises the provider from the key itself, and picks a key up from the clipboard when you come
 * back from the provider's page (only when the clipboard holds something shaped like a key for it). */
export function KeyField({ value, onChange, expect, autoFocus, onDetected }: {
  value: string; onChange: (v: string) => void; expect?: string; autoFocus?: boolean; onDetected?: (preset: string | null, name: string | null) => void;
}) {
  const [found, setFound] = useState("");
  const detect = useCallback(async (k: string) => {
    if (k.trim().length < 8) return onDetected?.(null, null);
    const r = await api<{ preset: string | null; name: string | null }>("/providers/detect", { body: { api_key: k.trim() } }).catch(() => null);
    if (r) onDetected?.(r.preset, r.name);
  }, [onDetected]);
  const fromClipboard = useCallback(async (quiet: boolean) => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t || t.length > 300 || /\s/.test(t) || (expect && !t.startsWith(expect))) {
        if (!quiet) setFound("Your clipboard doesn't hold a key yet.");
        return;
      }
      onChange(t);
      setFound("Found a key on your clipboard.");
      detect(t);
    } catch {
      if (!quiet) setFound("Paste it with Ctrl+V (or ⌘V) instead.");
    }
  }, [expect, onChange, detect]);
  useEffect(() => {
    const onFocus = () => { if (!value) fromClipboard(true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [value, fromClipboard]);
  return (
    <div className="st-stack">
      <div className="st-key">
        <Input type="password" autoFocus={autoFocus} autoComplete="off" spellCheck={false} value={value}
          placeholder={expect ? `${expect}…` : "Paste your key"} aria-label="API key"
          onChange={(e) => { onChange(e.target.value); setFound(""); detect(e.target.value); }} />
        <Button variant="ghost" size="sm" icon={<ClipboardPaste size={14} />} onClick={() => fromClipboard(false)}>Paste</Button>
      </div>
      {found && <p className="st-small">{found}</p>}
    </div>
  );
}

/** Sign in with ChatGPT (OpenAI's own sign-in in the browser), with Codex as the fallback. */
export function ChatGPTCard({ onConnected, cta = "Start chatting" }: { sub: Sub; onConnected: () => Promise<void> | void; cta?: string }) {
  const [state, setState] = useState<{ state: string; url: string } | null>(null);
  const [status, setStatus] = useState<{ status: string; error?: string; email?: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState("");
  const timer = useRef<number>();
  useEffect(() => () => window.clearInterval(timer.current), []);

  const start = async () => {
    setError("");
    setStatus(null);
    try {
      const r = await api<{ url: string; state: string }>("/auth/chatgpt/start", { body: {} });
      setState(r);
      window.open(r.url, "_blank", "noopener");
      window.clearInterval(timer.current);
      timer.current = window.setInterval(async () => {
        const s = await api<{ status: string; error?: string; email?: string }>(`/auth/chatgpt/status/${r.state}`).catch(() => null);
        if (s && s.status !== "pending") {
          window.clearInterval(timer.current);
          setStatus(s);
          setState(null);
        }
      }, 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const completePasted = async () => {
    const s = await api<{ status: string; error?: string; email?: string }>("/auth/chatgpt/complete", { body: { url: pasted.trim() } })
      .catch((e) => ({ status: "failed", error: (e as Error).message }));
    window.clearInterval(timer.current);
    setStatus(s);
    setState(null);
  };

  return (
    <div className="st-plan">
      <div className="st-plan-head">
        <BrandMark name="chatgpt" /><span className="st-plan-name">ChatGPT</span>
        {status?.status === "connected" && <Badge tone="ok"><Check size={11} /> Signed in</Badge>}
      </div>
      <p className="st-small">Use the ChatGPT plan you already pay for. In Chat, pick it as the model at the top.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {status?.status === "failed" && <Notice tone="danger">{status.error || "Sign-in didn't finish. Try again."}</Notice>}
      {status?.status === "connected" ? (
        <div className="st-inline">
          <span className="st-grow st-small"><Check size={14} /> Signed in as {status.email || "your ChatGPT account"}</span>
          <Button variant="primary" onClick={() => onConnected()}>{cta} <ArrowRight size={16} /></Button>
        </div>
      ) : state ? (
        <div className="st-stack">
          <div className="st-inline">
            <span className="st-grow st-small" role="status">Waiting for you to finish in the browser…</span>
            <ButtonLink href={state.url} variant="ghost" size="sm">Open again</ButtonLink>
          </div>
          <Advanced label="Signed in on another device?">
            <div className="st-key">
              <Input value={pasted} onChange={(e) => setPasted(e.target.value)} aria-label="The address the browser ended on" placeholder="Paste the address the browser ended on" />
              <Button size="sm" disabled={!pasted.includes("state=")} onClick={completePasted}>Finish</Button>
            </div>
          </Advanced>
        </div>
      ) : (
        <div><Button variant="primary" onClick={start}>Sign in with ChatGPT</Button></div>
      )}
      <Advanced label="Didn't work? Use ChatGPT through Codex instead">
        <PlanCard agent="codex" title="ChatGPT through Codex" onConnected={onConnected} cta={cta} nested
          blurb="OpenAI's own Codex app, signed in with your ChatGPT plan. A bit slower than the direct sign-in above." />
      </Advanced>
    </div>
  );
}

/** Settings: the plans you can sign in with, then a key paste box. Calls onChange after anything connects. */
export function SignInWithPlan({ onChange }: { onChange: () => void }) {
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [done, setDone] = useState("");
  useEffect(() => { api<{ options: Sub[] }>("/auth/subscriptions").then((r) => setSubs(r.options)).catch(() => setSubs([])); }, []);
  const chatgpt = subs?.find((s) => s.id === "chatgpt");
  const claude = subs?.find((s) => s.id === "claude" && s.available && s.via === "claude_code");
  const copilot = subs?.find((s) => s.id === "copilot" && s.available);
  const connected = (name: string) => async () => { setDone(name); onChange(); };
  if (subs === null) return <Loading rows={2} label="Loading the plans you can sign in with" />;
  return (
    <div className="st-stack">
      {done && <Notice tone="ok"><Check size={14} /> {done} is connected. It now shows up in every model menu.</Notice>}
      {chatgpt || claude || copilot ? (
        <div className="st-group">
          {chatgpt && <ChatGPTCard sub={chatgpt} onConnected={connected("ChatGPT")} cta="Use it" />}
          {claude && <PlanCard agent="claude" title="Claude" onConnected={connected("Claude")} cta="Use it"
            blurb="Use the Claude plan you already pay for. Sign-in opens in Anthropic's own app. In Chat, pick the model and the mode." />}
          {copilot && <PlanCard agent="copilot" title="GitHub Copilot" onConnected={connected("GitHub Copilot")} cta="Use it"
            blurb="Use the Copilot plan you already pay for. Sign-in opens in GitHub's own app." />}
        </div>
      ) : <p className="st-small">No plan sign-in is available in this build. Use a key below.</p>}
    </div>
  );
}

/** Settings: pick a provider (or just paste: it is recognised), open its key page, paste, checked before it is saved. */
export function AddKey({ presets, info, onChange }: { presets: Record<string, Preset>; info: Record<string, KeyInfo>; onChange: () => void }) {
  const choices = KEY_ORDER.filter((k) => k !== "compatible" && presets[k]).map((k) => [k, presets[k]] as const);
  const primaryIds = ["openai", "anthropic", "gemini", "groq"];
  const primary = choices.filter(([k]) => primaryIds.includes(k));
  const more = choices.filter(([k]) => !primaryIds.includes(k));
  const [kind, setKind] = useState("openai");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");
  const preset = presets[kind];
  const onDetected = useCallback((p: string | null) => { if (p && presets[p]) setKind(p); }, [presets]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setAdded("");
    try {
      const r = await api<Validation>("/providers/validate", { body: { api_key: key.trim(), preset: kind, save: true } });
      if (!r.ok) throw new Error(`${r.name} didn't accept that key (${r.detail}). Copy it again from the key page.`);
      setAdded(r.name);
      setKey("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!choices.length) return null;
  const pick = (k: string) => { setKind(k); setError(""); };
  const label = (k: string, p: Preset) => `${p.name}${info[k]?.free ? " (free)" : ""}`;
  return (
    <form className="st-form" onSubmit={submit}>
      <Choice label="Provider" value={primaryIds.includes(kind) ? kind : ""} onChange={pick} options={primary.map(([k, p]) => ({ id: k, label: label(k, p) }))} />
      {more.length > 0 && (
        <Advanced label="More providers" open={!primaryIds.includes(kind)}>
          <Choice label="More providers" value={primaryIds.includes(kind) ? "" : kind} onChange={pick} options={more.map(([k, p]) => ({ id: k, label: label(k, p) }))} />
        </Advanced>
      )}
      {preset?.note && <p className="st-small">{preset.note}</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      {added && <Notice tone="ok"><Check size={14} /> {added} is connected.</Notice>}
      <KeyField value={key} onChange={setKey} expect={info[kind]?.prefix} onDetected={onDetected} />
      <div className="st-form-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={key.trim().length < 8}>{busy ? "Checking…" : "Connect"}</Button>
        {info[kind]?.url && <ButtonLink href={info[kind].url} icon={<ExternalLink size={13} />}>Get {/^[AEIOU]/i.test(preset.name) ? "an" : "a"} {preset.name} key</ButtonLink>}
      </div>
      <p className="st-small st-inline"><ShieldCheck size={14} /> The key is tested before it is saved, stays on this computer, and only goes to {preset?.name}.</p>
    </form>
  );
}

type SearchStatus = { provider: string; name: string; signup: Record<string, string> };

/** Web search for Research and Chat: a free Tavily key, guided (open the page, copy, paste; tested before saving). */
export function WebSearchSetup({ compact = false, onChange }: { compact?: boolean; onChange?: () => void }) {
  const [st, setSt] = useState<SearchStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const [change, setChange] = useState(false);
  const load = () => api<SearchStatus>("/assistant/search").then(setSt).catch(() => setSt({ provider: "", name: "", signup: {} }));
  useEffect(() => { load(); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/assistant/search-key", { body: { provider: "tavily", key: key.trim() } });
      setKey("");
      setChange(false);
      await load();
      onChange?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <Loading rows={1} label="Checking web search" />;
  if (st.provider && !change) {
    return (
      <div className="st-inline">
        <span className="st-grow st-inline"><Check size={14} /> Web search is on ({st.name}).</span>
        {!compact && <Button variant="ghost" size="sm" onClick={() => setChange(true)}>Change key</Button>}
      </div>
    );
  }
  return (
    <form className="st-form" onSubmit={save}>
      <p className="st-p">{compact ? "Web search is off. " : ""}Turn it on with a free Tavily key: 1,000 searches a month, no card, about a minute.</p>
      <ol className="st-steps">
        <li className={opened ? "is-done" : ""}>
          <span className="st-step-n">1</span>
          <div className="st-step-body">
            <span>Open Tavily and make a free account. Your key is on the first page after you sign up.</span>
            <div><ButtonLink size="sm" href={st.signup.tavily || "https://app.tavily.com/home"} onClick={() => setOpened(true)} icon={<ExternalLink size={12} />}>Open Tavily</ButtonLink></div>
          </div>
        </li>
        <li>
          <span className="st-step-n">2</span>
          <div className="st-step-body">
            <span>Copy the key (it starts with tvly-), come back and paste it.</span>
            <KeyField value={key} onChange={setKey} expect="tvly-" />
          </div>
        </li>
      </ol>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="st-form-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={key.trim().length < 8}>{busy ? "Testing…" : "Turn on web search"}</Button>
        {change && <Button variant="ghost" onClick={() => setChange(false)}>Cancel</Button>}
      </div>
    </form>
  );
}
