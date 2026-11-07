import { Check, Plug, RefreshCw, Trash2, Wrench } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Loading, Page, Section, Select } from "../ui";
import { errorText } from "../ui/toast";
import { useToast } from "../util";
import { Advanced, SettingRow, SettingsGroup, Switch } from "./settings/index";

// feat/mcp-client: the user's own MCP servers. Tools they add show up in the assistant as mcp__<server>__<tool>;
// everything a server answers is treated as untrusted third-party content.

type Spec = {
  command: string; args: string[]; env: Record<string, string>; url: string; headers: Record<string, string>;
  transport: string; enabled: boolean; secret_env?: string[]; secret_headers?: string[];
};
type Server = {
  id: number; name: string; transport: string; url: string; command: string; enabled: boolean; spec: Spec;
  secrets: { env: string[]; headers: string[] }; needs_secrets: { env: string[]; headers: string[] };
  last_error: string; created_at: string;
};
type CatalogueEntry = {
  name: string; description: string; transport: string; command: string; args: string[];
  env: Record<string, string>; secret_env?: string[]; placeholders?: { args?: Record<string, string>; env?: Record<string, string> };
};
type ToolsInfo = { name: string; status: string; last_error: string; server_info: Record<string, string>; tools: { name: string; qualified: string; description: string }[] };

const KIND: Record<string, string> = { stdio: "Runs on this computer", streamable_http: "Connects to an address", sse: "Connects to an address (older kind)" };

export default function McpServers() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [failed, setFailed] = useState("");
  const [tools, setTools] = useState<ToolsInfo[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueEntry[] | null>(null);
  const [adding, setAdding] = useState<CatalogueEntry | "custom" | null>(null);
  const [openTools, setOpenTools] = useState<string | null>(null);
  const toast = useToast();

  const refresh = () => {
    setFailed("");
    api<{ servers: Server[] }>("/mcp/servers").then((r) => setServers(r.servers)).catch((e) => setFailed(errorText(e)));
    api<{ servers: ToolsInfo[] }>("/mcp/tools").then((r) => setTools(r.servers)).catch(() => setTools([]));
  };
  useEffect(() => {
    refresh();
    api<{ catalogue: CatalogueEntry[] }>("/mcp/catalogue").then((r) => setCatalogue(r.catalogue)).catch(() => setCatalogue([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (s: Server) => {
    try { await api(`/mcp/servers/${s.id}/toggle`, { body: { enabled: !s.enabled } }); } catch (e) { toast.err(e); }
    refresh();
  };
  const remove = async (s: Server) => {
    if (!confirm(`Remove "${s.name}"? Its tools leave the assistant right away.`)) return;
    try { await api(`/mcp/servers/${s.id}`, { method: "DELETE" }); toast.ok(`Removed ${s.name}.`); } catch (e) { toast.err(e); }
    refresh();
  };
  const test = async (s: Server) => {
    try {
      const r = await api<{ status: string; error?: string; tools: { name: string }[] }>(`/mcp/servers/${s.id}/test`, { body: {} });
      if (r.status === "connected") toast.ok(`${s.name}: connected, ${r.tools.length} tool${r.tools.length === 1 ? "" : "s"}.`);
      else toast.err(`${s.name}: ${r.error}`);
    } catch (e) {
      toast.err(e);
    }
    refresh();
  };

  const catalogued = new Set(servers?.map((s) => s.name) ?? []);
  return (
    <Page title="Extra tools" className="st-page"
      description="Outside tools the assistant can use. Everything they answer is treated as untrusted, and actions that leave this computer still wait for your OK."
      actions={<Button icon={<Plug size={14} />} onClick={() => setAdding("custom")}>Add a tool</Button>}>
      {adding && (
        <Section title={adding === "custom" ? "Add a tool" : `Add ${adding.name}`}>
          <AddForm entry={adding === "custom" ? null : adding} onDone={() => { setAdding(null); refresh(); }} onCancel={() => setAdding(null)} />
        </Section>
      )}

      <Section title="Your tools">
        {failed && !servers ? <ErrorState title="Your tools did not load" line={failed} onRetry={refresh} />
          : servers === null ? <Loading rows={2} label="Loading your tools" />
          : servers.length === 0 ? (
            <EmptyState icon={<Plug size={22} />} title="No extra tools yet" line="Pick one from the list below, or add your own."
              action={<Button onClick={() => setAdding("custom")}>Add a tool</Button>} />
          ) : (
            <SettingsGroup label="Your tools">
              {servers.map((s) => {
                const info = tools.find((t) => t.name === s.name);
                const live = s.enabled && info?.status === "connected";
                const broken = s.enabled && info?.status === "error";
                return (
                  <div key={s.id} className="st-item">
                    <div className="st-item-text">
                      <span className="st-item-title">
                        {s.name}
                        {!s.enabled ? <Badge>Off</Badge> : live ? <Badge tone="ok">Connected</Badge> : broken ? <Badge tone="warn">Not answering</Badge> : null}
                      </span>
                      <span className="st-item-meta">{KIND[s.transport] ?? "Outside tool"}{info && info.tools.length > 0 ? ` · ${info.tools.length} tool${info.tools.length === 1 ? "" : "s"}` : ""}</span>
                    </div>
                    <span className="st-item-actions">
                      <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={() => test(s)} disabled={!s.enabled}>Test</Button>
                      <Switch checked={s.enabled} onChange={() => toggle(s)} label={`Use ${s.name}`} />
                      <IconButton size="sm" label={`Remove ${s.name}`} onClick={() => remove(s)}><Trash2 size={14} /></IconButton>
                    </span>
                    <div className="st-item-body">
                      <Advanced open={openTools === s.name} label="Advanced">
                        <p className="st-small">How it runs: <span className="st-mono">{s.transport === "stdio" ? `${s.command} ${s.spec.args.join(" ")}`.trim() : s.url}</span></p>
                        {s.last_error && s.enabled && <p className="st-small st-danger">{s.last_error}</p>}
                        {info && info.tools.length > 0 && (
                          <div className="st-stack">
                            <Button variant="ghost" size="sm" icon={<Wrench size={13} />} onClick={() => setOpenTools(openTools === s.name ? null : s.name)}>
                              {openTools === s.name ? "Hide" : "Show"} {info.tools.length} tool{info.tools.length === 1 ? "" : "s"}
                            </Button>
                            {openTools === s.name && (
                              <ul className="st-tools">
                                {info.tools.map((t) => <li key={t.qualified}><span className="st-mono">{t.qualified}</span>{t.description ? `: ${t.description}` : ""}</li>)}
                              </ul>
                            )}
                          </div>
                        )}
                      </Advanced>
                    </div>
                  </div>
                );
              })}
            </SettingsGroup>
          )}
      </Section>

      <Section title="Ready to add" description="Well known tools that run on this computer. Add one and it is available in chat.">
        {catalogue === null ? <Loading rows={3} label="Loading the list" /> : catalogue.length === 0 ? <EmptyState title="Nothing to list" line="Add your own tool with the button above." /> : (
          <SettingsGroup label="Ready to add">
            {catalogue.map((c) => (
              <SettingRow key={c.name} label={c.name} help={c.description}>
                {catalogued.has(c.name) ? <Badge tone="ok"><Check size={12} /> Added</Badge> : <Button size="sm" onClick={() => setAdding(c)}>Add</Button>}
              </SettingRow>
            ))}
          </SettingsGroup>
        )}
      </Section>
    </Page>
  );
}

function AddForm({ entry, onDone, onCancel }: { entry: CatalogueEntry | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(entry?.name ?? "");
  const [transport, setTransport] = useState(entry?.transport ?? "stdio");
  const [command, setCommand] = useState(entry?.command ?? "");
  const [argsText, setArgsText] = useState(entry?.args.join(" ") ?? "");
  const [url, setUrl] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const secretSlots = entry?.secret_env ?? [];
  const argPlaceholders = entry?.placeholders?.args ?? {};
  // Placeholders the user has not replaced yet (still "<...>" in the args line) get their own input below.
  const openPlaceholders = Object.keys(argPlaceholders).filter((ph) => argsText.includes(ph));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let line = argsText;
      for (const ph of openPlaceholders) {
        const v = (secrets[`arg:${ph}`] ?? "").trim();
        if (v) line = line.split(ph).join(v);
      }
      if (/<[^>]+>/.test(line)) {
        toast.err("Replace every <placeholder> in the arguments first.");
        return;
      }
      const env: Record<string, string> = {};
      for (const k of secretSlots) env[k] = "";
      await api("/mcp/servers", {
        body: {
          name: name.trim(), transport, command, args: line.split(" ").filter(Boolean), env, url,
          secret_env: secretSlots,
          secrets: { env: Object.fromEntries(secretSlots.map((k) => [k, secrets[k] ?? ""])) },
        },
      });
      toast.ok(`Added ${name.trim()}.`);
      onDone();
    } catch (err) {
      toast.err(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="st-group st-form st-form-pad" onSubmit={submit}>
      <div className="st-form-grid">
        <Input label="Name" hint="Lowercase letters, digits, - or _" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-tool" required
          pattern="[a-z0-9][a-z0-9_-]{0,30}" title="lowercase letters, digits, - or _" />
        <Select label="How it connects" value={transport} onChange={(e) => setTransport(e.target.value)}>
          <option value="stdio">Runs a program on this computer</option>
          <option value="streamable_http">Connects to an address</option>
          <option value="sse">Connects to an address (older kind)</option>
        </Select>
      </div>
      {transport === "stdio" ? (
        <>
          <Input label="Program" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" required />
          <Input label="Arguments" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={entry?.args.join(" ") ?? "-y @modelcontextprotocol/server-memory"} />
          {openPlaceholders.map((ph) => (
            <Input key={ph} label={argPlaceholders[ph]} value={secrets[`arg:${ph}`] ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, [`arg:${ph}`]: e.target.value }))} required />
          ))}
        </>
      ) : (
        <Input label="Address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/tool" required type="url" />
      )}
      {secretSlots.map((k) => (
        <Input key={k} label={entry?.placeholders?.env?.[k] ?? k} type="password" value={secrets[k] ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))}
          placeholder="Stored encrypted, never shown again" required />
      ))}
      <div className="st-form-actions">
        <Button type="submit" variant="primary" busy={busy}>{busy ? "Adding…" : "Add tool"}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
