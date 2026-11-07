import { ArrowLeft, ArrowRight, BadgeCheck, Check, Cloud, Cpu, Download, ExternalLink, KeyRound, ListChecks, ShieldCheck } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, stream } from "../api";
import { BrandMark } from "../brand";
import PlanCard from "./PlanCard";
import { ChatGPTCard, KEY_ORDER, KeyField, KeyInfo, Preset, Sub, Validation } from "./ModelSignIn";
import { ThemeGrid, TypeChoices } from "../ThemePicker";
import { saveAppearanceRemote } from "../themeSync";
import { readAppearance } from "../appearance";
import { AssistantFace } from "../AssistantFace";
import { Badge, Button, EmptyState, Input, Loading } from "../ui";
import { Advanced, AuthActions, AuthCard, ButtonLink, Choice, Notice, Progress, SettingRow, SettingsGroup } from "./settings/index";

/** First run: "Choose how to think". Cloud is the default (nothing heavy runs on this computer); the smart router
 * then uses whatever was connected and falls back when a free tier runs out. */

type Model = { ref: string; model: string };

const STARTER_MODEL = "qwen3:4b";

async function modelsFor(pid: number): Promise<Model[]> {
  const { models } = await api<{ models: Model[] }>("/models?fresh=true");
  return models.filter((m) => m.ref.startsWith(`${pid}/`));
}

async function finish(pid: number, prefer?: string) {
  const models = await modelsFor(pid);
  if (!models.length) throw new Error("Connected, but no models were listed. Check the key, or try again in a moment.");
  const pick = models.find((m) => m.model === prefer || m.model === `${prefer}:latest`) ?? models[0];
  const { default: current } = await api<{ default: string }>("/models");
  if (!current.startsWith(`${pid}/`)) await api("/settings", { method: "PUT", body: { default_model: pick.ref } });
  await api("/desktop/welcome-done", { method: "POST" });
}

/** Cloud connections all go behind the smart router: "auto" picks a model per task and falls back on limits. */
async function finishCloud() {
  await api("/settings", { method: "PUT", body: { default_model: "auto" } });
  await api("/desktop/welcome-done", { method: "POST" });
}

function Back({ onBack }: { onBack: () => void }) {
  return <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={onBack}>Back</Button>;
}

const TRUST = <><ShieldCheck size={13} aria-hidden="true" /> Keys stay on this computer · <ListChecks size={13} aria-hidden="true" /> Every action is logged</>;

const FREE = [
  { id: "gemini", name: "Google Gemini", blurb: "Flash and Flash-Lite. A Google account is all you need.", steps: "Sign in, then Create API key." },
  { id: "groq", name: "Groq", blurb: "Very fast open models (gpt-oss-120b). No card.", steps: "Sign up, then Create API Key." },
];

function FreeStep({ info, onBack, onDone }: { info: Record<string, KeyInfo>; onBack: () => void; onDone: () => void }) {
  const [pick, setPick] = useState("gemini");
  const [key, setKey] = useState("");
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<string[]>([]);
  const p = FREE.find((f) => f.id === pick)!;
  const onDetected = useCallback((preset: string | null) => { if (preset === "gemini" || preset === "groq") setPick(preset); }, []);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<Validation>("/providers/validate", { body: { api_key: key.trim(), preset: pick, save: true } });
      if (!r.ok) throw new Error(`${r.name} didn't accept that key (${r.detail}). Copy it again from the key page.`);
      setConnected((c) => [...new Set([...c, pick])]);
      setKey("");
      setOpened(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const other = FREE.find((f) => f.id !== pick && !connected.includes(f.id));
  const done = connected.length > 0;

  return (
    <AuthCard step="Step 4 of 4" title="A free key, two minutes" footer={TRUST}
      line="Both are free with daily limits. Add both and the app switches to the other one when a limit is hit.">
      <form className="st-auth-form" onSubmit={connect}>
        {error && <Notice tone="danger">{error}</Notice>}
        <Choice label="Free provider" value={pick} onChange={(id) => { setPick(id); setKey(""); setOpened(false); }}
          options={FREE.map((f) => ({ id: f.id, label: connected.includes(f.id) ? `${f.name} · connected` : f.name }))} />
        <p className="st-small">{p.blurb}{info[pick]?.limits ? ` ${info[pick].limits}` : ""}</p>
        {connected.includes(pick) ? <Notice tone="ok"><Check size={14} /> {p.name} is connected.</Notice> : (
          <ol className="st-steps">
            <li className={opened ? "is-done" : ""}>
              <span className="st-step-n">1</span>
              <div className="st-step-body">
                <span>Open the {p.name} key page. {p.steps}</span>
                <div><ButtonLink size="sm" href={info[pick]?.url} onClick={() => setOpened(true)} icon={<ExternalLink size={12} />}>Open the key page</ButtonLink></div>
              </div>
            </li>
            <li>
              <span className="st-step-n">2</span>
              <div className="st-step-body">
                <span>Copy the key, come back, and paste it here.</span>
                <KeyField value={key} onChange={setKey} expect={info[pick]?.prefix} onDetected={onDetected} />
              </div>
            </li>
          </ol>
        )}
        <AuthActions>
          <Back onBack={onBack} />
          <span className="st-grow" />
          {done && other && !key && <Button variant="ghost" onClick={() => setPick(other.id)}>Add {other.name} too</Button>}
          {key.trim().length >= 8 ? (
            <Button type="submit" variant="primary" busy={busy}>{busy ? "Checking key…" : <>Check and connect <ArrowRight size={16} /></>}</Button>
          ) : (
            <Button variant="primary" disabled={!done || busy} onClick={async () => { await finishCloud(); onDone(); }}>Start chatting <ArrowRight size={16} /></Button>
          )}
        </AuthActions>
      </form>
    </AuthCard>
  );
}

/** Right after the PIN: the company's own sign-in, not another password typed in here. */
export function AccountsStep({ onNext }: { onNext: () => void }) {
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => { api<{ options: Sub[] }>("/auth/subscriptions").then((r) => setSubs(r.options)).catch(() => setSubs([])); }, []);
  const chatgpt = subs?.find((s) => s.id === "chatgpt");
  const claude = subs?.find((s) => s.id === "claude" && s.available && s.via === "claude_code");
  const openWindow = async (who: string) => {
    setNote("");
    try {
      await api("/mail/mac/settings", { method: "POST" });
      setNote(`A window from your Mac is open. Choose Add Account, pick ${who}, and sign in as usual. Your password stays with ${who}.`);
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  const go = async () => {
    await api("/desktop/signins-done", { method: "POST" }).catch(() => undefined);
    onNext();
  };
  return (
    <AuthCard step="Step 1 of 4" title="Sign in with the accounts you already use"
      line="Optional. Each one opens that company's own window. You can connect them later.">
      {note && <Notice>{note}</Notice>}
      <div className="st-stack">
        <p className="st-small">Mail and calendar</p>
        <div className="st-signins">
          <Button icon={<BrandMark name="google" />} onClick={() => openWindow("Google")}>Gmail</Button>
          <Button icon={<BrandMark name="microsoft" />} onClick={() => openWindow("Microsoft")}>Microsoft</Button>
          <Button icon={<BrandMark name="apple" />} onClick={() => openWindow("Apple")}>Apple</Button>
        </div>
      </div>
      {subs === null ? <Loading rows={1} label="Checking the plans you can sign in with" /> : (chatgpt || claude) && (
        <div className="st-stack">
          <p className="st-small">AI plans you already pay for</p>
          <div className="st-group">
            {chatgpt && <ChatGPTCard sub={chatgpt} onConnected={go} cta="Continue" />}
            {claude && <PlanCard agent="claude" title="Claude" onConnected={go} cta="Continue"
              blurb="Opens Claude's own sign-in. Use the plan you already pay for." />}
          </div>
        </div>
      )}
      <AuthActions>
        <span className="st-grow" />
        <Button variant="primary" onClick={go}>Skip for now <ArrowRight size={16} /></Button>
      </AuthActions>
    </AuthCard>
  );
}

function SubscriptionStep({ onBack, onDone, onKey }: { onBack: () => void; onDone: () => void; onKey: (preset: string) => void }) {
  const [subs, setSubs] = useState<Sub[] | null>(null);
  useEffect(() => {
    api<{ options: Sub[] }>("/auth/subscriptions").then((r) => setSubs(r.options)).catch(() => setSubs([]));
  }, []);
  const chatgpt = subs?.find((s) => s.id === "chatgpt");
  const claude = subs?.find((s) => s.id === "claude" && s.available && s.via === "claude_code");
  const copilot = subs?.find((s) => s.id === "copilot" && s.available);
  const start = async () => { await finishCloud(); onDone(); };

  return (
    <AuthCard step="Step 4 of 4" title="Sign in with your plan" footer={TRUST}
      line="No API key needed. Use the plan you already pay for, where the provider allows it.">
      {subs === null ? <Loading rows={2} label="Checking the plans you can sign in with" /> : (
        chatgpt || claude || copilot ? (
          <div className="st-group">
            {claude && <PlanCard agent="claude" title="Claude" onConnected={start}
              blurb="Use the Claude plan you already pay for. Sign-in opens in Anthropic's own app." />}
            {chatgpt && <ChatGPTCard sub={chatgpt} onConnected={start} />}
            {copilot && <PlanCard agent="copilot" title="GitHub Copilot" onConnected={start}
              blurb="Use the Copilot plan you already pay for. Sign-in opens in GitHub's own app." />}
          </div>
        ) : <EmptyState title="No plan sign-in here yet" line="Use a free key or paste a key instead." action={<Button onClick={onBack}>Choose another way</Button>} />
      )}
      {!!subs?.some((s) => !s.available) && (
        <Advanced label="Other plans: not available yet">
          <div className="st-group">
            {subs?.filter((s) => !s.available).map((s) => (
              <div key={s.id} className="st-plan">
                <div className="st-plan-head"><span className="st-plan-name">{s.name}</span><Badge>Not available yet</Badge></div>
                <p className="st-small">{s.plans ? `${s.plans}. ` : ""}{s.detail} <a className="st-link" href={s.source} target="_blank" rel="noreferrer">Why</a></p>
                <div><Button size="sm" variant="ghost" onClick={() => onKey(s.id === "claude" ? "anthropic" : s.id === "grok" ? "xai" : "gemini")}>Use a {s.name === "Gemini" ? "free Gemini" : s.name} key instead <ArrowRight size={13} /></Button></div>
              </div>
            ))}
          </div>
        </Advanced>
      )}
      <AuthActions><Back onBack={onBack} /></AuthActions>
    </AuthCard>
  );
}

function KeyStep({ presets, info, initial, onBack, onDone }: {
  presets: Record<string, Preset>; info: Record<string, KeyInfo>; initial?: string; onBack: () => void; onDone: () => void;
}) {
  const choices = KEY_ORDER.filter((k) => presets[k]).map((k) => [k, presets[k]] as const);
  const [kind, setKind] = useState(initial && presets[initial] ? initial : "openai");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const preset = presets[kind];
  const compatible = preset?.auth_kind === "openai_compatible";
  const onDetected = useCallback((p: string | null) => { if (p && presets[p]) setKind(p); }, [presets]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (compatible) {
        const p = await api<{ id: number }>("/providers", {
          body: { name: preset.name, auth_kind: preset.auth_kind, protocol: preset.protocol, base_url: baseUrl.trim() || preset.base_url, api_key: key.trim() },
        });
        const models = await modelsFor(p.id);
        if (!models.length) {
          await api(`/providers/${p.id}`, { method: "DELETE" });
          throw new Error("That server answered with no models. Check the address.");
        }
      } else {
        const r = await api<Validation>("/providers/validate", { body: { api_key: key.trim(), preset: kind, save: true } });
        if (!r.ok) throw new Error(`${r.name} didn't accept that key (${r.detail}).`);
      }
      setAdded((a) => [...a, preset.name]);
      setKey("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard step="Step 4 of 4" title="Paste your keys" footer={TRUST}
      line="Paste any key and the provider is recognised. Add as many as you like; the app uses them in turn.">
      <form className="st-auth-form" onSubmit={submit}>
        {error && <Notice tone="danger">{error}</Notice>}
        {added.length > 0 && <Notice tone="ok"><Check size={14} /> Connected: {added.join(", ")}</Notice>}
        <Choice label="Provider" value={kind} onChange={setKind}
          options={choices.map(([k, p]) => ({ id: k, label: k === "compatible" ? "Any compatible address" : p.name }))} />
        {preset?.note && <p className="st-small">{preset.note}</p>}
        {compatible && <Input label="Server address" className="st-mono" value={baseUrl} placeholder={preset.base_url} onChange={(e) => setBaseUrl(e.target.value)} />}
        <div className="st-stack">
          <span className="ui-field-label">API key{compatible ? " (optional for local servers)" : ""}</span>
          <KeyField value={key} onChange={setKey} autoFocus onDetected={compatible ? undefined : onDetected} />
          {info[kind]?.url && <a className="st-link st-small" href={info[kind].url} target="_blank" rel="noreferrer">Get {/^[AEIOU]/i.test(preset.name) ? "an" : "a"} {preset.name} key <ExternalLink size={11} aria-hidden="true" /></a>}
        </div>
        <p className="st-small">Your key stays on this computer (in the system keychain where available) and is only sent to {preset?.name}.</p>
        <AuthActions>
          <Back onBack={onBack} />
          <span className="st-grow" />
          {key.trim().length >= 8 || (compatible && baseUrl) ? (
            <Button type="submit" variant="primary" busy={busy}>{busy ? "Checking key…" : <>Check and connect <ArrowRight size={16} /></>}</Button>
          ) : (
            <Button variant="primary" disabled={!added.length} onClick={async () => { await finishCloud(); onDone(); }}>Start chatting <ArrowRight size={16} /></Button>
          )}
        </AuthActions>
      </form>
    </AuthCard>
  );
}

function OllamaStep({ preset, onBack, onDone }: { preset: Preset; onBack: () => void; onDone: () => void }) {
  const [state, setState] = useState<{ online: boolean; models: string[] } | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const check = () => api<{ online: boolean; models: string[] }>("/ollama/status").then(setState).catch(() => setState({ online: false, models: [] }));
  useEffect(() => {
    check();
  }, []);

  const pull = async () => {
    setError("");
    setPct(0);
    await stream("/ollama/pull", { model: STARTER_MODEL }, (e) => {
      if (e.error) setError(String(e.error));
      const total = Number(e.total ?? 0);
      if (total) setPct(Math.round((Number(e.completed ?? 0) / total) * 100));
    });
    setPct(null);
    check();
  };

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const p = await api<{ id: number }>("/providers", { body: { name: preset.name, auth_kind: preset.auth_kind, protocol: preset.protocol, base_url: preset.base_url } });
      await finish(p.id, state?.models.includes(STARTER_MODEL) ? STARTER_MODEL : state?.models[0]);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard step="Step 4 of 4" title="Use Ollama on this computer" line="Free and private: models run on your own machine and nothing leaves it.">
      {error && <Notice tone="danger">{error}</Notice>}
      <SettingsGroup>
        <SettingRow label="Ollama" help={state === null ? "Checking…" : state.online ? "Running on this computer." : "Install the free Ollama app, open it, then check again."}>
          {state === null ? null : state.online ? <Badge tone="ok">Running</Badge> : (
            <>
              <ButtonLink size="sm" href="https://ollama.com/download" icon={<Download size={14} />}>Get Ollama</ButtonLink>
              <Button size="sm" variant="ghost" onClick={check}>Check again</Button>
            </>
          )}
        </SettingRow>
        {state?.online && (
          <SettingRow label="A model" help={state.models.length ? `${state.models.length} model${state.models.length > 1 ? "s" : ""} installed.` : `No models yet. ${STARTER_MODEL} is a good first one (about 2.5 GB).`}>
            {!state.models.length && pct === null && <Button size="sm" icon={<Download size={14} />} onClick={pull}>Download {STARTER_MODEL}</Button>}
            {state.models.length > 0 && <Check size={16} aria-hidden="true" />}
          </SettingRow>
        )}
        {pct !== null && <div className="st-row"><div className="st-grow"><Progress value={pct} label={`Downloading ${STARTER_MODEL}: ${pct}%`} /></div></div>}
      </SettingsGroup>
      <AuthActions>
        <Back onBack={onBack} />
        <span className="st-grow" />
        <Button variant="primary" busy={busy} disabled={!state?.online || !state.models.length} onClick={connect}>
          {busy ? "Connecting…" : <>Start chatting <ArrowRight size={16} /></>}
        </Button>
      </AuthActions>
    </AuthCard>
  );
}

function NameStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = name.trim();
  const [pleasedAt, setPleasedAt] = useState(0);
  const named = useRef(false);
  useEffect(() => {
    if (chosen && !named.current) {
      named.current = true;
      setPleasedAt(Date.now());
    }
  }, [chosen]);

  const save = async () => {
    if (chosen) setPleasedAt(Date.now());
    setBusy(true);
    setError("");
    try {
      if (chosen) await api("/assistant/settings", { method: "PUT", body: { assistant_name: chosen } });
      onNext();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard step="Step 3 of 4" title="What should I be called?" line="This is the name on Home and in chat. You can change it later in Assistant settings.">
      <form className="st-auth-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="st-face"><AssistantFace mood="idle" name={chosen || "Atlas"} size={64} pleasedAt={pleasedAt} /></div>
        {error && <Notice tone="danger">{error}</Notice>}
        <Input label="Name" value={name} maxLength={40} autoFocus placeholder="Atlas" onChange={(e) => setName(e.target.value)} />
        <AuthActions>
          <Back onBack={onBack} />
          <span className="st-grow" />
          <Button type="submit" variant="primary" busy={busy}>
            {busy ? "Saving…" : <>{chosen ? `Call me ${chosen}` : "Keep the name Atlas"} <ArrowRight size={16} /></>}
          </Button>
        </AuthActions>
      </form>
    </AuthCard>
  );
}

export default function Welcome({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"accounts" | "look" | "name" | "choose" | "free" | "subscription" | "key" | "ollama">("accounts");
  const [keyPreset, setKeyPreset] = useState<string>();
  const [presets, setPresets] = useState<Record<string, Preset> | null>(null);
  const [info, setInfo] = useState<Record<string, KeyInfo>>({});
  useEffect(() => {
    api<{ presets: Record<string, Preset>; key_info: Record<string, KeyInfo> }>("/providers")
      .then((r) => { setPresets(r.presets); setInfo(r.key_info ?? {}); })
      .catch(() => setPresets({}));
  }, []);
  const back = () => setStep("choose");

  return (
    <div key={step} className="st-welcome">
      {step === "accounts" && <AccountsStep onNext={() => setStep("look")} />}
      {step === "name" && <NameStep onBack={() => setStep("look")} onNext={() => setStep("choose")} />}
      {step === "look" && (
        <AuthCard wide step="Step 2 of 4" title="Pick your look" line="Everything changes straight away, including the browser, the terminal and your phone. You can change it any time in Appearance.">
          <ThemeGrid />
          <TypeChoices />
          <AuthActions>
            <span className="st-small st-grow">Light is the everyday look.</span>
            <Button variant="primary" onClick={() => { saveAppearanceRemote(readAppearance()); setStep("name"); }}>Continue <ArrowRight size={14} /></Button>
          </AuthActions>
        </AuthCard>
      )}
      {step === "choose" && (
        <AuthCard step="Step 4 of 4" title="Choose how to think" footer={TRUST}
          line="The thinking happens in the cloud, so your computer stays cool and quiet. You can add more ways later.">
          {!presets ? <Loading rows={3} label="Loading the ways to connect" /> : (
            <div className="st-options">
              <button type="button" className="st-option" onClick={() => setStep("free")}>
                <span className="st-option-icon"><Cloud size={20} /></span>
                <span className="st-option-text">
                  <span className="st-option-title">Free cloud <Badge>Recommended</Badge></span>
                  <span className="st-option-line">A free Gemini or Groq key. Two minutes, no card.</span>
                </span>
                <ArrowRight size={16} className="st-option-go" aria-hidden="true" />
              </button>
              <button type="button" className="st-option" onClick={() => setStep("subscription")}>
                <span className="st-option-icon"><BadgeCheck size={20} /></span>
                <span className="st-option-text">
                  <span className="st-option-title">Sign in with your subscription</span>
                  <span className="st-option-line">ChatGPT, Claude, or GitHub Copilot: the plan you already pay for. No key needed.</span>
                </span>
                <ArrowRight size={16} className="st-option-go" aria-hidden="true" />
              </button>
              <button type="button" className="st-option" onClick={() => { setKeyPreset(undefined); setStep("key"); }}>
                <span className="st-option-icon"><KeyRound size={20} /></span>
                <span className="st-option-text">
                  <span className="st-option-title">Paste API keys</span>
                  <span className="st-option-line">OpenAI, Anthropic, xAI, Google, Groq, OpenRouter, Mistral, DeepSeek, or any compatible server.</span>
                </span>
                <ArrowRight size={16} className="st-option-go" aria-hidden="true" />
              </button>
              <button type="button" className="st-option" onClick={() => setStep("ollama")} disabled={!presets.ollama}>
                <span className="st-option-icon"><Cpu size={20} /></span>
                <span className="st-option-text">
                  <span className="st-option-title">Local Ollama <Badge>Advanced</Badge></span>
                  <span className="st-option-line">Private and offline. Needs a strong computer; it will run warm.</span>
                </span>
                <ArrowRight size={16} className="st-option-go" aria-hidden="true" />
              </button>
            </div>
          )}
          <AuthActions><Back onBack={() => setStep("name")} /></AuthActions>
        </AuthCard>
      )}
      {step === "free" && <FreeStep info={info} onBack={back} onDone={onDone} />}
      {step === "subscription" && <SubscriptionStep onBack={back} onDone={onDone} onKey={(p) => { setKeyPreset(p); setStep(p === "gemini" ? "free" : "key"); }} />}
      {step === "key" && presets && <KeyStep presets={presets} info={info} initial={keyPreset} onBack={back} onDone={onDone} />}
      {step === "ollama" && presets?.ollama && <OllamaStep preset={presets.ollama} onBack={back} onDone={onDone} />}
    </div>
  );
}
