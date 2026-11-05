import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../util";
import ConnectMailCalendar from "./ConnectMailCalendar";

type Preset = { name: string; auth_kind: string; protocol: string; base_url: string };
type CatalogueEntry = {
  name: string;
  description: string;
  transport: string;
  command: string;
  args: string[];
  secret_env?: string[];
  placeholders?: { args?: Record<string, string>; env?: Record<string, string> };
};
type Server = { id: number; name: string };

const OTHER = "other";

/** Plain names for the built-in tools. The page never uses a protocol name. */
const PLAIN: Record<string, { title: string; blurb: string }> = {
  filesystem: { title: "Files", blurb: "Read and write files in a folder you choose." },
  github: { title: "GitHub", blurb: "Repositories, issues and pull requests. Paste a token from GitHub." },
  fetch: { title: "Web page", blurb: "Read a web page as text." },
  memory: { title: "Memory", blurb: "A place the assistant can remember things." },
  sqlite: { title: "Database", blurb: "Look at one database file you choose." },
  playwright: { title: "Browser", blurb: "Open a site, click, and read the page." },
};

function plain(entry: CatalogueEntry) {
  return PLAIN[entry.name] ?? { title: entry.name, blurb: entry.description };
}

function fieldLabel(entry: CatalogueEntry, key: string): string {
  if (entry.name === "github") return "Token from GitHub";
  const raw = entry.placeholders?.env?.[key] ?? "Key";
  if (/https?:|github\.com|\//.test(raw)) return "Key";
  return raw;
}

/** A key from another project, saved the same way as any other model connection. */
function OwnKey({ onChange }: { onChange?: () => void }) {
  const [presets, setPresets] = useState<Record<string, Preset>>({});
  const [choice, setChoice] = useState("openai");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api<{ presets: Record<string, Preset> }>("/providers")
      .then((r) => {
        const known = Object.fromEntries(Object.entries(r.presets).filter(([, p]) => p.auth_kind === "api_key"));
        setPresets(known);
        const first = Object.keys(known)[0];
        if (first) {
          setChoice(first);
          setName(known[first].name);
          setAddress(known[first].base_url);
        }
      })
      .catch(() => undefined);
  }, []);

  const pick = (id: string) => {
    setChoice(id);
    if (id === OTHER) {
      setName("");
      setAddress("");
      return;
    }
    const p = presets[id];
    if (p) {
      setName(p.name);
      setAddress(p.base_url);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const preset = choice === OTHER ? null : presets[choice];
    setBusy(true);
    try {
      await api("/providers", {
        body: {
          name: (preset?.name || name).trim(),
          auth_kind: preset?.auth_kind || "openai_compatible",
          protocol: preset?.protocol || "chat_completions",
          base_url: (preset?.base_url || address).trim(),
          api_key: key,
          models: models.trim(),
        },
      });
      setKey("");
      setModels("");
      toast.ok("Saved. It shows up in the model list.");
      onChange?.();
    } catch (err) {
      toast.err(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card col gap-lg" onSubmit={save}>
      <div>
        <h2 style={{ margin: 0 }}>A key you already have</h2>
        <p className="muted small">A key only works for the company that gave it to you. A GitHub token goes on the GitHub tool below. A search key stays under Models.</p>
      </div>
      <label className="field">Company
        <select className="input" value={choice} aria-label="Company" onChange={(e) => pick(e.target.value)}>
          {Object.entries(presets).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
          <option value={OTHER}>Another service</option>
        </select>
      </label>
      {choice === OTHER && (
        <>
          <label className="field">Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Name you will recognise" />
          </label>
          <label className="field">Address
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} required placeholder="The service address, starting with https://" />
          </label>
          <label className="field">Model name <span className="hint">Optional. Use this when the service does not list its models.</span>
            <input className="input" value={models} onChange={(e) => setModels(e.target.value)} placeholder="Model name" />
          </label>
        </>
      )}
      {choice !== OTHER && address && <p className="muted small" style={{ margin: 0 }}>Address filled in for {presets[choice]?.name}.</p>}
      <label className="field">Key
        <input className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} required placeholder="Paste the key" />
      </label>
      <div><button className="btn primary" disabled={busy || key.trim().length < 8}>{busy ? "Saving…" : "Save key"}</button></div>
      {toast.node}
    </form>
  );
}

function ToolRow({ entry, added, onAdded }: { entry: CatalogueEntry; added: boolean; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const copy = plain(entry);
  const secretEnv = entry.secret_env ?? [];
  const argSlots = entry.placeholders?.args ?? {};

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let line = entry.args.join(" ");
      for (const [ph, value] of Object.entries(slots)) line = line.split(ph).join(value.trim());
      const env: Record<string, string> = {};
      for (const k of secretEnv) env[k] = "";
      await api("/mcp/servers", {
        body: {
          name: entry.name,
          transport: entry.transport,
          command: entry.command,
          args: line.split(" ").filter(Boolean),
          env,
          url: "",
          secret_env: secretEnv,
          secrets: { env: Object.fromEntries(secretEnv.map((k) => [k, secrets[k] ?? ""])) },
        },
      });
      setSecrets({});
      setOpen(false);
      toast.ok(`${copy.title} is connected.`);
      onAdded();
    } catch (err) {
      toast.err(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="list-item" style={{ cursor: "default", alignItems: "flex-start" }}>
      <div className="grow col" style={{ gap: 6 }}>
        <strong>{copy.title}</strong>
        <span className="muted small">{copy.blurb}</span>
        {open && !added && (
          <form className="col" style={{ gap: 8 }} onSubmit={add}>
            {Object.entries(argSlots).map(([ph, label]) => (
              <label className="field" key={ph}>{label}
                <input className="input" value={slots[ph] ?? ""} onChange={(e) => setSlots((s) => ({ ...s, [ph]: e.target.value }))} required />
              </label>
            ))}
            {secretEnv.map((k) => (
              <label className="field" key={k}>{fieldLabel(entry, k)}
                <input className="input" type="password" autoComplete="off" value={secrets[k] ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))} required placeholder="Stored on this computer, never shown again" />
              </label>
            ))}
            <div className="row">
              <button className="btn primary sm" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
              <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </form>
        )}
        {toast.node}
      </div>
      {added ? <span className="badge ok">On</span> : !open && <button type="button" className="btn sm" onClick={() => setOpen(true)}>Add</button>}
    </div>
  );
}

/** Sign in, a key you already have, and a tool. No new items on the side rail. */
export default function ConnectSection({ onChange }: { onChange?: () => void }) {
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const reload = () => {
    api<{ catalogue: CatalogueEntry[] }>("/mcp/catalogue").then((r) => setCatalogue(r.catalogue)).catch(() => setCatalogue([]));
    api<{ servers: Server[] }>("/mcp/servers").then((r) => setServers(r.servers)).catch(() => setServers([]));
  };
  useEffect(() => { reload(); }, []);
  const on = new Set(servers.map((s) => s.name));

  return (
    <div className="col gap-lg" id="connect">
      <ConnectMailCalendar onChange={onChange} />
      <p className="muted small" style={{ margin: 0 }}>Files from Microsoft and accounting tools are not connected from here yet.</p>
      <OwnKey onChange={onChange} />
      <div className="card col" style={{ gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>A tool</h2>
          <p className="muted small">Add a tool the assistant can use. Anything it does outside this computer still waits for you to allow it.</p>
        </div>
        <div className="card flush">
          {catalogue.map((entry) => (
            <ToolRow key={entry.name} entry={entry} added={on.has(entry.name)} onAdded={reload} />
          ))}
        </div>
        <div className="row wrap">
          <Link className="btn" to="/mcp">Add your own</Link>
          <Link className="btn" to="/skills?tab=add">From GitHub</Link>
        </div>
        <p className="muted small" style={{ margin: 0 }}>From GitHub, nothing is installed until you approve it.</p>
      </div>
      <div className="card col">
        <h2>Other calendars</h2>
        <p className="muted small">Google and Microsoft calendars come with your mail account. To add another calendar, use the Calendar page.</p>
        <div><Link className="btn" to="/calendar">Open calendar</Link></div>
      </div>
    </div>
  );
}
