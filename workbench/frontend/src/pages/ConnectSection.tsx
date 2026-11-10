import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, ErrorState, Input, Loading, Section, Select } from "../ui";
import { useToast } from "../util";
import { useDevTools } from "../lib/devTools";
import ConnectMailCalendar from "./ConnectMailCalendar";
import { ButtonLink, SettingRow, SettingsGroup } from "./settings/index";

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
    <Section title="A key you already have" description="A key only works for the company that gave it to you. A GitHub token goes on the GitHub tool below. A search key stays under Models.">
      <form onSubmit={save}>
        <SettingsGroup>
          <SettingRow label="Company" help={choice !== OTHER && address ? `Address filled in for ${presets[choice]?.name}.` : undefined}>
            <Select value={choice} aria-label="Company" onChange={(e) => pick(e.target.value)}>
              {Object.entries(presets).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
              <option value={OTHER}>Another service</option>
            </Select>
          </SettingRow>
          {choice === OTHER && (
            <>
              <SettingRow label="Name" help="A name you will recognise.">
                <Input value={name} onChange={(e) => setName(e.target.value)} required aria-label="Name" placeholder="Name" />
              </SettingRow>
              <SettingRow label="Address" help="The service address, starting with https://">
                <Input value={address} onChange={(e) => setAddress(e.target.value)} required aria-label="Address" placeholder="https://" />
              </SettingRow>
              <SettingRow label="Model name" help="Optional. Use this when the service does not list its models.">
                <Input value={models} onChange={(e) => setModels(e.target.value)} aria-label="Model name" placeholder="Model name" />
              </SettingRow>
            </>
          )}
          <SettingRow label="Key" help="Stays on this computer.">
            <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} required aria-label="Key" placeholder="Paste the key" />
          </SettingRow>
          <div className="st-row st-row-foot"><Button type="submit" variant="primary" busy={busy} disabled={key.trim().length < 8}>{busy ? "Saving…" : "Save key"}</Button></div>
        </SettingsGroup>
      </form>
    </Section>
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
    <div className="st-item">
      <div className="st-item-text">
        <span className="st-item-title">{copy.title}</span>
        <span className="st-item-meta">{copy.blurb}</span>
      </div>
      <span className="st-item-actions">
        {added ? <Badge tone="ok">On</Badge> : !open && <Button size="sm" onClick={() => setOpen(true)}>Add</Button>}
      </span>
      {open && !added && (
        <form className="st-item-body" onSubmit={add}>
          {Object.entries(argSlots).map(([ph, label]) => (
            <Input key={ph} label={label} value={slots[ph] ?? ""} onChange={(e) => setSlots((s) => ({ ...s, [ph]: e.target.value }))} required />
          ))}
          {secretEnv.map((k) => (
            <Input key={k} label={fieldLabel(entry, k)} type="password" autoComplete="off" value={secrets[k] ?? ""}
              onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))} required placeholder="Stored on this computer, never shown again" />
          ))}
          <div className="st-form-actions">
            <Button type="submit" variant="primary" size="sm" busy={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Sign in, a key you already have, and a tool. No new items on the side rail. */
export default function ConnectSection({ onChange }: { onChange?: () => void }) {
  const [catalogue, setCatalogue] = useState<CatalogueEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [servers, setServers] = useState<Server[]>([]);
  const reload = () => {
    setFailed(false);
    api<{ catalogue: CatalogueEntry[] }>("/mcp/catalogue").then((r) => setCatalogue(r.catalogue)).catch(() => setFailed(true));
    api<{ servers: Server[] }>("/mcp/servers").then((r) => setServers(r.servers)).catch(() => setServers([]));
  };
  useEffect(() => { reload(); }, []);
  const on = new Set(servers.map((s) => s.name));
  const devTools = useDevTools(); // Extra tools is a developer page (Settings, Advanced)

  return (
    <div className="st-stack" id="connect">
      <Section title="Mail and calendar" description="Files from Microsoft and accounting tools are not connected from here yet.">
        <ConnectMailCalendar onChange={onChange} />
      </Section>
      <OwnKey onChange={onChange} />
      <Section title="A tool" description="Add a tool the assistant can use. Anything it does outside this computer still waits for you to allow it.">
        {failed ? <ErrorState title="The tools did not load" line="The app did not answer. Try again in a moment." onRetry={reload} />
          : catalogue === null ? <Loading rows={3} label="Loading tools" /> : (
            <SettingsGroup label="Tools">
              {catalogue.map((entry) => <ToolRow key={entry.name} entry={entry} added={on.has(entry.name)} onAdded={reload} />)}
              <SettingRow label="Something else" help="From GitHub, nothing is installed until you approve it.">
                {devTools && <ButtonLink size="sm" to="/extra-tools">Add your own</ButtonLink>}
                <ButtonLink size="sm" to="/skills?tab=add">From GitHub</ButtonLink>
              </SettingRow>
            </SettingsGroup>
          )}
      </Section>
      <Section title="Other calendars">
        <SettingsGroup>
          <SettingRow label="Another calendar" help="Google and Microsoft calendars come with your mail account. To add another calendar, use the Calendar page.">
            <ButtonLink size="sm" to="/calendar">Open calendar</ButtonLink>
          </SettingRow>
        </SettingsGroup>
      </Section>
    </div>
  );
}
