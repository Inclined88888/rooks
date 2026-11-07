import { Copy, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useToast } from "../../util";
import { WebSearchSetup } from "../../pages/ModelSignIn";

/** Chat settings (/assistant-settings): the assistant's name, time zone, learning, another app, web search, Telegram, terminal access. */
type ASettings = { assistant_name: string; timezone: string; learning_enabled: boolean; search_provider: string; cli_token_set: boolean;
  reach_channel?: string;
  telegram: { configured: boolean; running: boolean; bot: string; error: string; allowed_users: string } };

export function SettingsTab() {
  const [s, setS] = useState<ASettings | null>(null);
  const [f, setF] = useState({ assistant_name: "", timezone: "", tg_token: "", tg_users: "" });
  const [token, setToken] = useState("");
  const toast = useToast();
  const load = () => api<ASettings>("/assistant/settings").then((r) => { setS(r); setF((x) => ({ ...x, assistant_name: r.assistant_name, timezone: r.timezone, tg_users: r.telegram.allowed_users })); });
  useEffect(() => { load(); }, []);
  const put = async (body: Record<string, unknown>, msg = "Saved") => {
    try { setS(await api<ASettings>("/assistant/settings", { method: "PUT", body })); toast.ok(msg); } catch (e) { toast.err(e); }
  };
  if (!s) return null;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="col gap-lg">
      <div className="card col">
        <h3>Basics</h3>
        <div className="row wrap">
          <label className="field grow">Assistant name<input className="ui-input" value={f.assistant_name} onChange={(e) => setF({ ...f, assistant_name: e.target.value })} /></label>
          <label className="field grow">Timezone (schedules follow it)<input className="ui-input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} placeholder={browserTz} /></label>
        </div>
        <div className="row">
          {f.timezone !== browserTz && <button className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => setF({ ...f, timezone: browserTz })}>Use {browserTz}</button>}
          <div className="spacer" />
          <button className="ui-btn ui-btn-primary" onClick={() => put({ assistant_name: f.assistant_name, timezone: f.timezone })}>Save</button>
        </div>
        <label className="check"><input type="checkbox" checked={s.learning_enabled} onChange={(e) => put({ learning_enabled: e.target.checked })} /> Learn memories and skills automatically (uses extra model calls)</label>
        <label className="field">Also tell me on another app
          <select className="ui-select" aria-label="Also tell me on another app" value={s.reach_channel || "off"} onChange={(e) => put({ reach_channel: e.target.value }, "Saved")}>
            <option value="off">Just in this app</option>
            <option value="telegram">Telegram, once it's connected below</option>
            <option value="slack">Slack (connect it on Channels)</option>
          </select>
        </label>
        <p className="small muted">New routines follow this. Telegram needs the connection below. Slack keeps using the Channels page. Nothing is sent until you say yes.</p>
      </div>
      <div className="card col">
        <h3>Web search</h3>
        <WebSearchSetup />
      </div>
      <div className="card col">
        <div className="row"><h3 className="grow">Telegram</h3>{s.telegram.running ? <span className="badge ok">@{s.telegram.bot} online</span> : s.telegram.configured ? <span className="badge danger">offline</span> : <span className="badge">not set up</span>}</div>
        {s.telegram.error && <div className="alert err">{s.telegram.error}</div>}
        <div className="muted small">1. Message @BotFather in Telegram, send /newbot, paste the token. 2. Message @userinfobot for your user id. Only listed ids get answers; scheduled reports go to the first one.</div>
        <div className="row wrap">
          <input className="ui-input grow" type="password" placeholder={s.telegram.configured ? "Token saved (paste to replace)" : "Bot token"} value={f.tg_token} onChange={(e) => setF({ ...f, tg_token: e.target.value })} />
          <input className="ui-input" style={{ width: 200 }} placeholder="Your user id(s), comma separated" value={f.tg_users} onChange={(e) => setF({ ...f, tg_users: e.target.value })} />
          <button className="ui-btn" onClick={() => put({ ...(f.tg_token ? { telegram_token: f.tg_token } : {}), telegram_allowed_users: f.tg_users }, "Telegram saved; connecting…").then(() => setTimeout(load, 4000))}>Save</button>
          {s.telegram.configured && <button className="ui-btn ui-btn-ghost ui-btn-danger" onClick={() => put({ telegram_token: "" }, "Telegram disconnected")}>Disconnect</button>}
        </div>
      </div>
      <div className="card col">
        <div className="row"><KeyRound size={15} /><h3 className="grow">Terminal access</h3>{s.cli_token_set && <span className="badge ok">token active</span>}</div>
        <div className="muted small">Install the <span className="mono">ws</span> command (cli/ws in the repository, Python 3 only), then run <span className="mono">ws login {window.location.origin}</span> and paste the token.</div>
        <div className="row">
          <button className="ui-btn" onClick={async () => { const r = await api<{ token: string }>("/cli-token", { method: "POST" }); setToken(r.token); load(); }}>{s.cli_token_set ? "Replace token" : "Create token"}</button>
          {token && <><span className="mono small truncate grow">{token}</span><button className="ui-btn ui-btn-sm" onClick={() => { navigator.clipboard.writeText(token); toast.ok("Copied"); }}><Copy size={13} /></button></>}
        </div>
        {token && <div className="alert">Shown once. It replaces any previous token.</div>}
      </div>
    </div>
  );
}
