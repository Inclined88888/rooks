import { ArrowRight, Check, Download, Lock } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { api, saveBrowserToken, stream } from "../api";
import type { Status } from "../App";
import { PRODUCT } from "../product";
import { Badge, Button, Input } from "../ui";
import { Advanced, AuthActions, AuthCard, ButtonLink, Notice, Progress, SettingRow, SettingsGroup } from "./settings/index";

const SUGGESTED = [
  { model: "qwen3:4b", note: "Fast all rounder, ~2.5 GB. Good on CPU." },
  { model: "qwen3:8b", note: "Stronger reasoning, ~5 GB. Best with a GPU." },
  { model: "gemma3:4b", note: "Google's small model, ~3 GB." },
  { model: "nomic-embed-text", note: "Embeddings for document search in Chat." },
];

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/login", { body: { password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form className="st-auth-form" onSubmit={submit}>
        {error && <Notice tone="danger">{error}</Notice>}
        <Input label="PIN or password" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" busy={busy} disabled={!password}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="st-auth-alt">
        <PairCode busy={busy} onDone={onDone} onError={setError} />
        <Button variant="ghost" disabled={busy} onClick={async () => {
          if (!window.confirm("The old PIN can't be looked up. Set a new one? Your mail, notes and tasks stay.")) return;
          setBusy(true);
          setError("");
          try { await api("/lock/reset", { method: "POST" }); onDone(); }
          catch (err) { setError((err as Error).message); setBusy(false); }
        }}>Forgot it? Set a new one</Button>
      </div>
    </>
  );
}

function PairCode({ busy, onDone, onError }: { busy: boolean; onDone: () => void; onError: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  if (!open) return <Button variant="ghost" disabled={busy} onClick={() => setOpen(true)}>I have a pairing code</Button>;
  const connect = async () => {
    setWorking(true);
    try {
      const r = await api<{ token: string }>("/browser/pair/claim", { body: { code } });
      saveBrowserToken(r.token);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="st-auth-form">
      <Input label="Pairing code" hint="Made in Settings, Tools, on the computer Rooks runs on." value={code} autoComplete="one-time-code" placeholder="ABCD-EFGH" onChange={(e) => setCode(e.target.value)} />
      <Button busy={working} disabled={code.trim().length < 8} onClick={connect}>{working ? "Checking…" : "Connect this browser"}</Button>
    </div>
  );
}

function ModelsStep({ onNext }: { onNext: () => void }) {
  const [ollama, setOllama] = useState<{ online: boolean; models: string[] } | null>(null);
  const [pulling, setPulling] = useState<string>("");
  const [progress, setProgress] = useState<{ status: string; pct: number }>({ status: "", pct: 0 });
  const [keys, setKeys] = useState({ openai: "", anthropic: "", openrouter: "", gemini: "" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const check = () => api<{ online: boolean; models: string[] }>("/ollama/status").then(setOllama).catch(() => setOllama({ online: false, models: [] }));
  useEffect(() => {
    check();
  }, []);

  const pull = async (model: string) => {
    setPulling(model);
    setError("");
    await stream("/ollama/pull", { model }, (e) => {
      if (e.error) setError(String(e.error));
      const total = Number(e.total ?? 0);
      const done = Number(e.completed ?? 0);
      setProgress({ status: String(e.status ?? ""), pct: total ? Math.round((done / total) * 100) : 0 });
    });
    setPulling("");
    check();
  };

  const saveKeys = async () => {
    setError("");
    try {
      const { providers, presets } = await api<{ providers: { kind: string; base_url: string }[]; presets: Record<string, { name: string; base_url: string }> }>("/providers");
      for (const [kind, key] of Object.entries(keys)) {
        if (!key.trim()) continue;
        const preset = presets[kind];
        if (providers.some((p) => p.base_url === preset.base_url)) continue;
        await api("/providers", { body: { name: preset.name, kind: kind === "anthropic" ? "anthropic" : "openai", base_url: preset.base_url, api_key: key.trim() } });
      }
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {error && <Notice tone="danger">{error}</Notice>}
      <SettingsGroup label="Models on this computer">
        <SettingRow label="Models on this computer" help="Run through the free Ollama app.">
          {ollama === null ? <span className="st-small" role="status">Checking…</span> : ollama.online ? <Badge tone="ok">Running</Badge> : <Button size="sm" onClick={check}>Check again</Button>}
        </SettingRow>
        {ollama?.online && SUGGESTED.map((s) => {
          const have = ollama.models.some((m) => m === s.model || m === `${s.model}:latest`);
          return (
            <SettingRow key={s.model} label={s.model} help={s.note}>
              {have ? <Badge tone="ok"><Check size={12} /> Installed</Badge> : (
                <Button size="sm" icon={<Download size={14} />} busy={pulling === s.model} disabled={!!pulling} onClick={() => pull(s.model)}>{pulling === s.model ? `${progress.pct}%` : "Download"}</Button>
              )}
            </SettingRow>
          );
        })}
        {pulling && <div className="st-row"><div className="st-grow"><Progress value={progress.pct} label={progress.status || "Downloading…"} /></div></div>}
      </SettingsGroup>
      <Advanced label="Cloud providers (optional)">
        <Input label="OpenAI API key" type="password" value={keys.openai} onChange={(e) => setKeys({ ...keys, openai: e.target.value })} placeholder="sk-…" />
        <Input label="Anthropic API key" type="password" value={keys.anthropic} onChange={(e) => setKeys({ ...keys, anthropic: e.target.value })} placeholder="sk-ant-…" />
        <Input label="OpenRouter API key" hint="Free key. Models ending in :free cost nothing." type="password" value={keys.openrouter} onChange={(e) => setKeys({ ...keys, openrouter: e.target.value })} placeholder="sk-or-…" />
        <Input label="Google Gemini API key" hint="Free tier from Google AI Studio. Google may use free tier prompts to improve its products." type="password" value={keys.gemini} onChange={(e) => setKeys({ ...keys, gemini: e.target.value })} placeholder="AIza…" />
        <div className="st-form-actions">
          <Button onClick={saveKeys} disabled={!Object.values(keys).some((k) => k.trim())}>Save keys</Button>
          {saved && <Badge tone="ok"><Check size={12} /> Saved</Badge>}
        </div>
        <p className="st-small">Keys are stored encrypted on this computer and never shown again. You can change them any time in AI models.</p>
      </Advanced>
      <Button variant="primary" className="st-auth-full" onClick={onNext} disabled={!!pulling}>Continue <ArrowRight size={16} /></Button>
    </>
  );
}

export default function Auth({ status, onDone }: { status: Status; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ password: "", confirm: "", setup_code: "", workspace_name: status.workspace_name });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (status.setup_complete && step === 0) {
    return (
      <AuthCard title="Welcome back" line={`Use the PIN or password you created for ${PRODUCT}.`}
        footer={<><Lock size={12} aria-hidden="true" /> On this computer. {PRODUCT} is not a shared service.</>}>
        <Login onDone={onDone} />
      </AuthCard>
    );
  }

  const createAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError("Those don't match. Type the same PIN or password twice.");
    setBusy(true);
    setError("");
    try {
      await api("/setup", { body: { password: form.password, setup_code: form.setup_code, workspace_name: form.workspace_name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "" } });
      onDone();  // straight to the first-run welcome: accounts, look, name, then how to think
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 1) {
    return (
      <AuthCard wide title="Connect models" line="Local models run on this computer through Ollama. Cloud providers are optional and can be added later in Settings.">
        <ModelsStep onNext={() => setStep(2)} />
      </AuthCard>
    );
  }
  if (step === 2) {
    return (
      <AuthCard title="You're set" line="Connect mail and calendars any time under Settings.">
        <ul className="st-checks">
          <li><Check size={14} /> Your workspace: chat, mail, calendar, tasks, notes, files and research.</li>
          {status.chat_url && <li><Check size={14} /> An optional chat window is ready. The first account you create there becomes its admin.</li>}
          <li><Check size={14} /> In Chat, turn on the workspace tools (the + menu in the message box) so it can use your notes, tasks and calendar.</li>
        </ul>
        <AuthActions>
          {status.chat_url && <ButtonLink href={status.chat_url}>Open the chat window</ButtonLink>}
          <span className="st-grow" />
          <Button variant="primary" onClick={onDone}>Open workspace <ArrowRight size={16} /></Button>
        </AuthActions>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set a PIN or password"
      line={`This locks ${PRODUCT} on this computer. Next you can sign in with Gmail, Apple, Microsoft, ChatGPT or Claude.`}
      footer={<><Lock size={12} aria-hidden="true" /> On this computer. {PRODUCT} is not a shared service.</>}>
      <form className="st-auth-form" onSubmit={createAccount}>
        {error && <Notice tone="danger">{error}</Notice>}
        {status.setup_code_required && (
          <Input label="Setup code" hint="Printed when this app was installed." className="st-mono" value={form.setup_code} onChange={(e) => setForm({ ...form, setup_code: e.target.value })} autoFocus />
        )}
        <Input label="PIN or password" hint="At least 6 characters." type="password" autoComplete="new-password" autoFocus={!status.setup_code_required}
          value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <Input label="Type it again" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        <Advanced label="Name this workspace">
          <Input label="Workspace name" value={form.workspace_name} onChange={(e) => setForm({ ...form, workspace_name: e.target.value })} />
        </Advanced>
        <Button type="submit" variant="primary" busy={busy} disabled={form.password.length < 6}>{busy ? "Setting it…" : <>Set PIN <ArrowRight size={16} /></>}</Button>
      </form>
    </AuthCard>
  );
}
