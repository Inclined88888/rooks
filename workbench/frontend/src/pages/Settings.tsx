import { Check, Download, FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, stream } from "../api";
import { AppInfo, Sidecar, appInfo, inDesktopShell, listSidecars, openDataDir, openLogs, requestApproval } from "../desktop";
import { Badge, Button, ErrorState, IconButton, Input, Loading, Page, Section, Select } from "../ui";
import { errorText } from "../ui/toast";
import { ModelSelect, useModels, useToast } from "../util";
import ConnectSection from "./ConnectSection";
import { AddKey, KeyInfo, SignInWithPlan, WebSearchSetup } from "./ModelSignIn";
import { PhoneCard } from "./Phone";
import { Advanced, ButtonLink, CategoryNav, Notice, Progress, SettingRow, SettingsGroup, Switch } from "./settings/index";
import { SETTINGS_SECTIONS as SECTIONS } from "./settings/sections";

type DesktopInfo = { desktop: boolean; data_dir: string; secret_backend: string };
type SettingsData = { workspace_name: string; default_model: string; chat_url: string; tools_url: string; model_catalog_refresh: boolean; model_catalog_env: boolean };

function BrowserPair() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const make = async () => {
    setErr("");
    try {
      const r = await api<{ code: string }>("/browser/pair/start", { method: "POST" });
      setCode(r.code);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <SettingsGroup>
      <SettingRow label="Open Rooks in a browser"
        help="On another device you own, open this computer's address and choose “I have a pairing code”. The code works once, for about 10 minutes. There is no shared Rooks in the cloud.">
        <Button onClick={make}>{code ? "Make another code" : "Make a pairing code"}</Button>
      </SettingRow>
      {code && <SettingRow label="Pairing code" help="Type it on the other device."><span className="st-pair-code">{code}</span></SettingRow>}
      {err && <div className="st-row"><Notice tone="danger">{err}</Notice></div>}
    </SettingsGroup>
  );
}

/** Desktop app only: where data lives, how keys are protected, and the helper processes (sidecars). */
function DesktopApp({ info }: { info: DesktopInfo }) {
  const [app, setApp] = useState<AppInfo | null>(null);
  const [sidecars, setSidecars] = useState<Sidecar[]>([]);
  const [answer, setAnswer] = useState("");
  const shell = inDesktopShell();
  useEffect(() => {
    if (!shell) return;
    appInfo().then(setApp).catch(() => undefined);
    listSidecars().then(setSidecars).catch(() => undefined);
  }, [shell]);
  const test = async () => setAnswer((await requestApproval("Test approval", "This is what an approval prompt looks like. Nothing will happen either way.", "low")) ? "Approved" : "Denied");
  return (
    <Section title="Desktop app">
      <SettingsGroup>
        <SettingRow label="Your data" help="Everything you make is kept in one folder on this computer.">
          {shell && <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => openDataDir()}>Open folder</Button>}
        </SettingRow>
        <SettingRow label="Keys" help={info.secret_backend === "os-keychain" ? "Stored in this computer's keychain." : "Encrypted in your data folder (this computer has no keychain)."} />
        {app && <SettingRow label="Updates" help={app.updater ? "Automatic." : "Manual for now: download new versions from the releases page."} />}
        {sidecars.map((sc) => (
          <SettingRow key={sc.name} label={sc.name} help={sc.description}>
            <Badge tone={sc.status === "running" ? "ok" : sc.status === "failed" ? "danger" : "neutral"}>{sc.status === "running" ? "Running" : sc.status === "failed" ? "Stopped with a problem" : sc.status}</Badge>
          </SettingRow>
        ))}
        {shell && (
          <SettingRow label="Approval prompt" help="See what an approval looks like. Nothing happens either way.">
            {answer && <Badge>{answer}</Badge>}
            <Button size="sm" variant="ghost" onClick={test}>Test it</Button>
          </SettingRow>
        )}
        <div className="st-row">
          <Advanced>
            <p className="st-small">Data folder: <span className="st-mono">{info.data_dir}</span></p>
            {app && <p className="st-small">Version {app.version} · {app.platform} {app.arch}</p>}
            {shell && <div><Button size="sm" icon={<FolderOpen size={14} />} onClick={() => openLogs()}>Open logs</Button></div>}
          </Advanced>
        </div>
      </SettingsGroup>
    </Section>
  );
}

type Provider = { id: number; name: string; auth_kind: string; protocol: string; base_url: string; models: string; enabled: number;
  has_key: boolean; key_hint: string; state: string; last_error: string };
type Presets = Record<string, { name: string; auth_kind: string; protocol: string; base_url: string; note?: string }>;

// The connection types for a custom connection (Advanced). Plans are signed in to with their own cards above it.
const CONNECTION_TYPES: Record<string, string> = {
  "api_key/chat_completions": "API key · Chat Completions",
  "api_key/responses": "API key · OpenAI Responses",
  "api_key/anthropic_messages": "API key · Anthropic Messages",
  "openai_compatible/chat_completions": "OpenAI compatible server (key optional)",
  "local_ollama/ollama_native": "Ollama (local)",
};
const KIND_LABEL: Record<string, string> = {
  api_key: "API key", cli_subscription: "Your plan", oauth: "Your plan", chatgpt: "Your plan", subscription: "Your plan",
  local_ollama: "On this computer", openai_compatible: "Custom server",
};
const kindLabel = (p: { auth_kind: string; protocol: string }) =>
  KIND_LABEL[p.auth_kind] ?? CONNECTION_TYPES[`${p.auth_kind}/${p.protocol}`] ?? p.auth_kind;
const EMPTY_FORM = { name: "", type: "openai_compatible/chat_completions", base_url: "", api_key: "", models: "" };

/** The model connections: what is connected, a plan to sign in with, a key to paste, and (Advanced) a custom server.
 *  Also used by the AI models page. */
export function Providers({ onChange }: { onChange?: () => void } = {}) {
  const [list, setList] = useState<Provider[] | null>(null);
  const [failed, setFailed] = useState("");
  const [presets, setPresets] = useState<Presets>({});
  const [info, setInfo] = useState<Record<string, KeyInfo>>({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [note, setNote] = useState("");
  const toast = useToast();
  const load = () => api<{ providers: Provider[]; presets: Presets; key_info?: Record<string, KeyInfo> }>("/providers")
    .then((r) => { setList(r.providers); setPresets(r.presets); setInfo(r.key_info ?? {}); setFailed(""); onChange?.(); })
    .catch((e) => { setFailed(errorText(e)); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const [auth_kind, protocol] = form.type.split("/");
      await api("/providers", { body: { name: form.name, auth_kind, protocol, base_url: form.base_url, api_key: form.api_key, models: form.models } });
      setForm(EMPTY_FORM);
      setNote("");
      load();
      toast.ok("Added");
    } catch (err) { toast.err(err); }
  };
  const toggle = async (p: Provider) => {
    try {
      await api(`/providers/${p.id}`, { method: "PUT", body: { name: p.name, auth_kind: p.auth_kind, protocol: p.protocol, base_url: p.base_url, models: p.models, enabled: !p.enabled } });
    } catch (err) { toast.err(err); }
    load();
  };
  const remove = async (p: Provider) => {
    if (!confirm(`Disconnect ${p.name}? Its saved key or sign-in is removed from this computer.`)) return;
    try { await api(`/providers/${p.id}`, { method: "DELETE" }); } catch (err) { toast.err(err); }
    load();
  };
  const usePreset = (k: string) => {
    const p = presets[k];
    if (p) setForm({ ...form, name: p.name, base_url: p.base_url, type: `${p.auth_kind}/${p.protocol}` });
    setNote(p?.note ?? "");
  };
  const advancedPresets = Object.keys(presets).filter((k) => presets[k].auth_kind !== "cli_subscription");

  return (
    <div className="st-stack" id="models">
      <Section title="Connected">
        {list === null ? (failed ? <ErrorState title="Your connections did not load" line={failed} onRetry={load} /> : <Loading rows={2} label="Loading your connections" />)
          : list.length > 0 ? (
            <SettingsGroup label="Connected models">
              {list.map((p) => (
                <div key={p.id} className="st-item">
                  <div className="st-item-text">
                    <span className="st-item-title">
                      {p.name}
                      <Badge>{kindLabel(p)}</Badge>
                      {!p.enabled ? <Badge>Off</Badge>
                        : p.state === "connected" ? <Badge tone="ok"><Check size={11} /> Connected</Badge>
                        : <Badge tone={p.state === "needs_auth" ? "warn" : "neutral"}>{p.state === "needs_auth" ? "Needs sign-in" : p.state}</Badge>}
                    </span>
                    {p.last_error && <span className="st-item-meta is-danger">{p.last_error}</span>}
                  </div>
                  <span className="st-item-actions">
                    <Switch checked={!!p.enabled} onChange={() => toggle(p)} label={`Use ${p.name}`} />
                    <IconButton size="sm" label={`Disconnect ${p.name}`} onClick={() => remove(p)}><Trash2 size={14} /></IconButton>
                  </span>
                </div>
              ))}
            </SettingsGroup>
          ) : <Notice>Nothing connected yet. Sign in with a plan or paste a key below.</Notice>}
      </Section>

      <Section title="Sign in with a plan you already pay for" description="No key needed. Answers count against your plan.">
        <SignInWithPlan onChange={load} />
      </Section>

      <Section title="Or paste a key" description="The ones marked (free) cost nothing. Paste any key and the provider is recognised from it.">
        <AddKey presets={presets} info={info} onChange={load} />
        <div className="st-advanced-gap">
          <Advanced label="Advanced: a custom server, Ollama, or exact model names">
            <form className="st-form" onSubmit={add}>
              {advancedPresets.length > 0 && (
                <div className="st-inline">
                  <span className="st-small">Start from:</span>
                  {advancedPresets.map((k) => <Button key={k} size="sm" onClick={() => usePreset(k)}>{presets[k].name}</Button>)}
                </div>
              )}
              {note && <p className="st-small">{note}</p>}
              <div className="st-form-grid">
                <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <Select label="Connection type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {Object.entries(CONNECTION_TYPES).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </Select>
              </div>
              <Input label="Address" required placeholder="https://api.groq.com/openai/v1" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
              <div className="st-form-grid">
                <Input label="API key" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
                <Input label="Models" hint="Optional, separated by commas." value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} />
              </div>
              <div className="st-form-actions"><Button type="submit" variant="primary" icon={<Plus size={15} />}>Add</Button></div>
              <p className="st-small">Any OpenAI compatible server works (LM Studio, vLLM, LiteLLM, Together, Mistral). If it has no model list, type the model names.</p>
            </form>
          </Advanced>
        </div>
      </Section>
    </div>
  );
}

function LocalModels() {
  const [status, setStatus] = useState<{ online: boolean; models: string[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [pull, setPull] = useState<{ model: string; pct: number; status: string } | null>(null);
  const toast = useToast();
  const load = () => { setFailed(false); api<{ online: boolean; models: string[] }>("/ollama/status").then(setStatus).catch(() => setFailed(true)); };
  useEffect(() => { load(); }, []);
  const start = async (e: FormEvent) => {
    e.preventDefault();
    const model = name.trim();
    setPull({ model, pct: 0, status: "starting" });
    await stream("/ollama/pull", { model }, (ev) => {
      if (ev.error) toast.err(String(ev.error));
      const total = Number(ev.total ?? 0);
      setPull({ model, pct: total ? Math.round((Number(ev.completed ?? 0) / total) * 100) : 0, status: String(ev.status ?? "") });
    });
    setPull(null);
    setName("");
    load();
  };
  return (
    <Section title="AI on this computer" description="Private and free, but slower and less capable than the cloud. It needs the free Ollama app."
      actions={<IconButton size="sm" label="Check again" onClick={load}><RefreshCw size={14} /></IconButton>}>
      {failed ? <ErrorState title="Could not check this computer" line="The app did not answer. Try again in a moment." onRetry={load} />
        : !status ? <Loading rows={1} label="Checking for Ollama" /> : (
          <SettingsGroup>
            <SettingRow label="Ollama" help={status.online ? "Running on this computer." : "Not running. Download it, open it, then check again."}>
              {status.online ? <Badge tone="ok">Running</Badge> : <ButtonLink size="sm" href="https://ollama.com/download" icon={<Download size={13} />}>Get Ollama</ButtonLink>}
            </SettingRow>
            <SettingRow label="Downloaded models" help={status.models.length ? "Shared with Chat." : "No models downloaded yet."}>
              {status.models.length > 0 && <span className="st-inline">{status.models.map((m) => <Badge key={m}>{m}</Badge>)}</span>}
            </SettingRow>
            <SettingRow stack label="Download a model" help="A 4B model needs about 4 GB of memory, 8B about 8 GB, 14B about 12 GB. A graphics card makes them much faster.">
              <form className="st-key" onSubmit={start}>
                <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Model name" placeholder="Model name, e.g. qwen3:8b" />
                <Button type="submit" icon={<Download size={15} />} busy={!!pull} disabled={!name.trim()}>{pull ? "Downloading…" : "Download"}</Button>
              </form>
              {pull && <Progress value={pull.pct} label={`${pull.model}: ${pull.status}${pull.pct ? ` ${pull.pct}%` : ""}`} />}
            </SettingRow>
          </SettingsGroup>
        )}
    </Section>
  );
}

type UsageSummary = { month_cents: number; month_tokens: number; prices: Record<string, { in: number; out: number }>;
  by_model: { model: string; tokens: number; cents: number; unpriced_calls: number }[]; by_channel: { channel: string; cents: number; tokens: number }[] };

function Usage() {
  const [u, setU] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState("");
  const [row, setRow] = useState({ model: "", in: "", out: "" });
  const toast = useToast();
  const load = () => { setFailed(""); api<UsageSummary>("/usage").then(setU).catch((e) => setFailed(errorText(e))); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const savePrices = async (prices: UsageSummary["prices"]) => {
    try { setU(await api<UsageSummary>("/usage/prices", { method: "PUT", body: { prices } })); toast.ok("Prices saved"); } catch (e) { toast.err(e); }
  };
  return (
    <Section title="Usage this month" description="Everything the AI did this month, by model. Free tiers and plans cost nothing extra here. A paid key shows $0 until you set its price."
      actions={u ? <Badge>${(u.month_cents / 100).toFixed(2)} · {u.month_tokens.toLocaleString()} tokens</Badge> : undefined}>
      {failed ? <ErrorState title="Usage did not load" line={failed} onRetry={load} /> : !u ? <Loading rows={2} label="Loading usage" /> : (
        <div className="st-stack">
          <SettingsGroup label="Usage by model">
            {u.by_model.length === 0 && <SettingRow label="No usage yet" help="Chat with the assistant and what it uses shows here." />}
            {u.by_model.map((m) => (
              <div key={m.model} className="st-item">
                <div className="st-item-text">
                  <span className="st-item-title st-mono">{m.model}</span>
                  <span className="st-item-meta">{Number(m.tokens).toLocaleString()} tokens · ${(m.cents / 100).toFixed(2)}</span>
                </div>
                {m.unpriced_calls > 0 && !u.prices[m.model] && <span className="st-item-actions"><Button size="sm" onClick={() => setRow({ model: m.model, in: "", out: "" })}>Set price</Button></span>}
              </div>
            ))}
          </SettingsGroup>
          <SettingsGroup label="Prices">
            <SettingRow stack label="Set a price" help="From the provider's pricing page, in dollars per million tokens.">
              <div className="st-form-grid st-price">
                <Input aria-label="Model" placeholder="Model" value={row.model} onChange={(e) => setRow({ ...row, model: e.target.value })} />
                <div className="st-key">
                  <Input type="number" min={0} step="any" aria-label="Dollars per million tokens in" placeholder="$ in" value={row.in} onChange={(e) => setRow({ ...row, in: e.target.value })} />
                  <Input type="number" min={0} step="any" aria-label="Dollars per million tokens out" placeholder="$ out" value={row.out} onChange={(e) => setRow({ ...row, out: e.target.value })} />
                </div>
              </div>
              <div><Button disabled={!row.model || row.in === "" || row.out === ""} onClick={() => { savePrices({ ...u.prices, [row.model]: { in: Number(row.in), out: Number(row.out) } }); setRow({ model: "", in: "", out: "" }); }}>Save price</Button></div>
            </SettingRow>
            {Object.entries(u.prices).map(([m, p]) => (
              <div key={m} className="st-item">
                <div className="st-item-text"><span className="st-item-title st-mono">{m}</span><span className="st-item-meta">${p.in} in · ${p.out} out per million</span></div>
                <span className="st-item-actions"><IconButton size="sm" label={`Remove the price for ${m}`} onClick={() => { const n = { ...u.prices }; delete n[m]; savePrices(n); }}><Trash2 size={14} /></IconButton></span>
              </div>
            ))}
          </SettingsGroup>
        </div>
      )}
    </Section>
  );
}

/** A row that opens another page. */
function Go({ label, help, to, primary }: { label: string; help: string; to: string; primary?: boolean }) {
  return <SettingRow label={label} help={help}><ButtonLink size="sm" variant={primary ? "primary" : "secondary"} to={to}>Open</ButtonLink></SettingRow>;
}

export default function Settings({ onChanged }: { onChanged: () => void }) {
  const { models, reload } = useModels();
  const [params, setParams] = useSearchParams();
  const section = useMemo(() => {
    const id = params.get("section") || "general";
    return SECTIONS.some((s) => s.id === id) ? id : "general";
  }, [params]);
  const go = (id: string) => setParams(id === "general" ? {} : { section: id }, { replace: true });
  const [s, setS] = useState<SettingsData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pw, setPw] = useState({ current: "", new: "" });
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  const loadSettings = useCallback(() => {
    setLoadError("");
    api<SettingsData>("/settings").then(setS).catch((e) => setLoadError(errorText(e)));
  }, []);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { api<DesktopInfo>("/desktop/info").then(setDesktop).catch(() => setDesktop(null)); }, []);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try { setS(await api("/settings", { method: "PUT", body: { workspace_name: s.workspace_name, default_model: s.default_model } })); toast.ok("Saved"); onChanged(); }
    catch (e) { toast.err(e); }
    finally { setSaving(false); }
  };
  const setCatalog = async (on: boolean) => {
    try { setS(await api("/settings", { method: "PUT", body: { model_catalog_refresh: on } })); toast.ok(on ? "Model prices will update once a day" : "Model price updates are off"); }
    catch (e) { toast.err(e); }
  };
  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    try { await api("/password", { body: pw }); setPw({ current: "", new: "" }); toast.ok("Password changed. Other sessions were signed out."); }
    catch (err) { toast.err(err); }
  };

  const meta = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  const settingsState = loadError ? <ErrorState title="Settings did not load" line={loadError} onRetry={loadSettings} /> : <Loading rows={2} label="Loading settings" />;

  return (
    <div className="st-layout">
      <CategoryNav items={SECTIONS} value={section} onChange={go} />
      <Page title={meta.label} description={meta.line} className="st-page">
        {section === "general" && (
          <>
            <Section title="Workspace">
              {!s ? settingsState : (
                <SettingsGroup>
                  <SettingRow label="Workspace name" help="Shown at the top of the app." htmlFor="st-workspace-name">
                    <Input id="st-workspace-name" value={s.workspace_name} onChange={(e) => setS({ ...s, workspace_name: e.target.value })} />
                  </SettingRow>
                  <SettingRow label="Default model" help="Auto picks a fitting model for each job. Pick one to always use it instead.">
                    <span className="st-key st-model-pick">
                      <ModelSelect value={s.default_model} onChange={(v) => setS({ ...s, default_model: v })} models={models} />
                      <IconButton size="sm" label="Refresh the model list" onClick={() => reload(true)}><RefreshCw size={14} /></IconButton>
                    </span>
                  </SettingRow>
                  <div className="st-row st-row-foot"><Button variant="primary" busy={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button></div>
                </SettingsGroup>
              )}
            </Section>
            {desktop?.desktop && <DesktopApp info={desktop} />}
            {!desktop?.desktop && (
              <Section title="Password" description="The password that locks this copy of Rooks. Changing it signs out other sessions.">
                <form onSubmit={changePw}>
                  <SettingsGroup>
                    <SettingRow label="Current password" htmlFor="st-pw-current">
                      <Input id="st-pw-current" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                    </SettingRow>
                    <SettingRow label="New password" help="At least 10 characters." htmlFor="st-pw-new">
                      <Input id="st-pw-new" type="password" autoComplete="new-password" value={pw.new} onChange={(e) => setPw({ ...pw, new: e.target.value })} />
                    </SettingRow>
                    <div className="st-row st-row-foot"><Button type="submit" disabled={!pw.current || pw.new.length < 10}>Change password</Button></div>
                  </SettingsGroup>
                </form>
              </Section>
            )}
          </>
        )}

        {section === "agents" && (
          <>
            <Section title="Assistant">
              <SettingsGroup>
                <Go primary label="Chat agent" help="Name, learning, search, and how it reaches you." to="/assistant-settings" />
                <Go label="Ask from anywhere and voice" help="The shortcut that opens the ask bar over any app, how it listens, and how it sounds." to="/voice" />
              </SettingsGroup>
            </Section>
            <Section title="Phone">
              <PhoneCard />
            </Section>
          </>
        )}

        {section === "models" && (
          <>
            <Section title="AI models">
              <SettingsGroup>
                <Go primary label="Which model does what" help="Sign in with ChatGPT or Claude, paste a key, and choose which model does what." to="/models" />
              </SettingsGroup>
            </Section>
            <Providers onChange={onChanged} />
            <LocalModels />
            <Section title="Web search" description="Lets Research and Chat look things up on the web.">
              <div id="search"><WebSearchSetup /></div>
            </Section>
          </>
        )}

        {section === "tools" && (
          <>
            <Section title="Tools">
              <SettingsGroup>
                <Go primary label="Extra tools" help="Outside tools you add yourself. Their actions still ask before they leave this computer." to="/extra-tools" />
                <Go label="Computer" help="Let the assistant click and type on this machine, when you allow it." to="/computer" />
                <Go label="Browser" help="Let the assistant work in a browser, when you allow it." to="/browser" />
                <Go label="Customize tools" help="Every tool in one list." to="/customize?tab=tools" />
              </SettingsGroup>
            </Section>
            <Section title="Another device">
              <BrowserPair />
            </Section>
          </>
        )}

        {section === "skills" && (
          <Section title="Skills and rules">
            <SettingsGroup>
              <Go primary label="Skills" help="Saved ways of working. Add more whenever you like." to="/skills" />
              <Go label="About you" help="Standing instructions and what it already knows about you." to="/about-you" />
              <Go label="Memory" help="Everything it remembers, in one place." to="/knowledge" />
              <Go label="Customize" help="One place for apps, tools, skills and rules." to="/customize" />
            </SettingsGroup>
          </Section>
        )}

        {section === "apps" && <ConnectSection onChange={onChanged} />}

        {section === "appearance" && (
          <Section title="Look">
            <SettingsGroup>
              <Go primary label="Appearance" help="Light, dark or high contrast, the typeface, text size and motion." to="/appearance" />
              <Go label="Your plan" help="Free or Pro, and what each includes." to="/plan" />
            </SettingsGroup>
          </Section>
        )}

        {section === "privacy" && (
          <Section title="Privacy">
            <SettingsGroup>
              <Go primary label="Privacy" help="What stays on this computer, and what leaves only when you say yes." to="/privacy" />
              <Go label="About" help="What Rooks is, in plain words." to="/about" />
            </SettingsGroup>
          </Section>
        )}

        {section === "advanced" && (
          <>
            <Section title="Model prices and limits">
              {!s ? settingsState : (
                <SettingsGroup>
                  <SettingRow label="Update model prices daily"
                    help={s.model_catalog_env ? "Set by the server; change it there." : "Costs and context sizes come from a list built into the app. Turn this on to download a newer list once a day."}>
                    <Switch checked={s.model_catalog_refresh} disabled={s.model_catalog_env} onChange={setCatalog} label="Update model prices daily" />
                  </SettingRow>
                </SettingsGroup>
              )}
            </Section>
            <Usage />
            {s?.chat_url && (
              <Section title="Open WebUI">
                <SettingsGroup>
                  <SettingRow label="Open WebUI" help="Optional chat that can use your notes, tasks, calendar and mail drafts (it can never send mail).">
                    <ButtonLink size="sm" href={s.chat_url}>Open</ButtonLink>
                  </SettingRow>
                </SettingsGroup>
              </Section>
            )}
            <Section title="System">
              <SettingsGroup>
                <Go label="System status" help="Each part of the app, checked when you open it." to="/status" />
                <Go label="Run log" help="Every turn and model call, with what it did." to="/runs" />
                <Go label="History" help="Everything you have asked, by day." to="/history" />
              </SettingsGroup>
            </Section>
          </>
        )}
      </Page>
    </div>
  );
}
