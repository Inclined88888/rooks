// Skills: installed, the store, add from GitHub with the security check, and activity. Premium pass (package C):
// built on the primitives, every list with a loading, an empty and an error state, and a phone layout.
import { ArrowRight, BookOpen, Check, ExternalLink, Github, KeyRound, Lock, Puzzle, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { FormEvent, Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, stream } from "../api";
import { Markdown, relTime, useToast } from "../util";
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Tabs, Textarea } from "../ui";
import { Gate, plainError, useLoad } from "./agents/kit";

// ---------------------------------------------------------------------------------------------------- types
type Finding = { rule: string; severity: "critical" | "high" | "medium" | "low"; category: string; message: string; file: string; line: number; snippet: string; tool?: string };
type Perms = { network: string[]; files: string[]; env: string[]; shell: boolean; tools: string[]; scripts: string[]; undeclared: string[] };
type Violation = { kind: string; what: string; target: string };
type Run = { script: string; status: string; exit: number | null; isolation?: string; stdout: string; stderr: string; violations: Violation[] };
type Trial = { status: string; runs: Run[]; violations: Violation[]; layers: string[]; note?: string };
type Risk = { level: "low" | "medium" | "high"; reasons: string[]; counts: Record<string, number> };
type Diff = { added: string[]; removed: string[]; changed: string[]; patches: string[]; permissions: string[] };
type Report = {
  static: Finding[]; injection: Finding[]; permissions: Perms; permissions_plain: string[]; trial: Trial; risk: Risk;
  scanners: string[]; files: string[]; manifest: { kind: string; mcp?: { command: string; args: string[]; remote_code?: boolean } | null };
  source: { owner: string; repo: string; path: string; ref: string; sha: string }; diff?: Diff;
};
type HubSkill = {
  id: number; name: string; description: string; kind: "skill" | "mcp"; source_url: string; owner: string; repo: string; path: string;
  ref: string; commit_sha: string; status: string; risk: Risk["level"]; report: Report; granted: Partial<Perms>; update_of: number | null;
  updated_at: string; installed_at: string | null; confirm_phrase?: string;
};
type StageId = "fetch" | "static" | "injection" | "permissions" | "sandbox" | "risk";
type StageState = { status: "waiting" | "running" | "done" | "choose"; detail: string };
type Choice = { name: string; path: string; url: string };
type SearchHit = { name: string; full_name: string; path: string; description: string; stars: number | null; url: string; kind: string };
type AuditRow = { id: number; skill_name: string; event: string; detail: string; created_at: string };
type PermRequest = { id: number; skill_name: string; kind: string; target: string; what: string; created_at: string };
type HubSettings = { has_token: boolean; scanners: string[]; isolation: string[] };

const STAGES: { id: StageId; label: string }[] = [
  { id: "fetch", label: "Fetch, pinned to one commit" },
  { id: "static", label: "Code scan" },
  { id: "injection", label: "Prompt-injection scan" },
  { id: "permissions", label: "What it can touch" },
  { id: "sandbox", label: "Sealed trial run" },
  { id: "risk", label: "Risk verdict" },
];
const blankStages = () => Object.fromEntries(STAGES.map((s) => [s.id, { status: "waiting", detail: "" }])) as Record<StageId, StageState>;
const RISK_COPY = { low: "Low risk", medium: "Medium risk", high: "High risk · blocked" } as const;

// ---------------------------------------------------------------------------------------------------- page
export default function Skills() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "installed" | "store" | "add" | "activity") || "installed";
  const go = (t: string) => setParams(t === "installed" ? {} : { tab: t }, { replace: true });
  const pending = useLoad(() => api<PermRequest[]>("/hub/requests").then((r) => r.length), [tab]);

  return (
    <Page className="ag-page sk-page" title="Skills" description="Teach me a new trick. I check anything you add before it can run."
      actions={<Tabs label="Skills" value={tab} onChange={go}
        items={[{ id: "installed", label: "Installed" }, { id: "store", label: "Store" }, { id: "add", label: "Add" }, { id: "activity", label: "Activity", count: pending.data || undefined }]} />}>
      {tab === "installed" && <Installed onAdd={() => go("store")} />}
      {tab === "store" && <StoreTab onAdded={() => go("installed")} />}
      {tab === "add" && <AddFromGitHub onInstalled={() => go("installed")} />}
      {tab === "activity" && <ActivityTab onChange={(n) => pending.set(n)} />}
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------- store
type StoreSkill = { id: string; name: string; description: string; why: string; added: boolean; for_you: boolean };
type StoreConnector = { id: string; name: string; blurb: string; to: string; on: boolean };

function StoreTab({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const store = useLoad(() => api<{ skills: StoreSkill[]; connectors: StoreConnector[] }>("/skills/store"), []);
  const add = async (id: string) => {
    try {
      await api(`/skills/store/${id}`, { method: "POST", body: {} });
      toast.ok("Skill added");
      store.reload();
    } catch (e) { toast.err(e); }
  };
  return (
    <Gate state={store} rows={5}>{(data) => {
      const forYou = data.skills.filter((s) => s.for_you);
      const show = forYou.length ? forYou : data.skills.slice(0, 3);
      if (!data.skills.length && !data.connectors.length) return <EmptyState icon={<Puzzle size={20} />} title="The store is empty" line="Copy a skill from a project instead." action={<Button onClick={() => setParams({ tab: "add" })}>Copy from a project</Button>} />;
      return <>
        <Section title="For you" description="These follow how you already use this. Work mail brings administration skills forward.">
          <List className="ag-list" label="For you">
            {show.map((s) => (
              <Row key={s.id} title={s.name} meta={<>{s.description}<br />{s.why}</>}
                actions={s.added ? <Button size="sm" onClick={onAdded}>Added</Button> : <Button size="sm" variant="primary" onClick={() => add(s.id)}>Add</Button>} />
            ))}
          </List>
        </Section>
        <Section title="Connectors">
          <List className="ag-list" label="Connectors">
            {data.connectors.map((c) => (
              <Row key={c.id} title={c.name} meta={c.blurb} onClick={() => navigate(c.to)} actions={c.on ? <Badge tone="ok">On</Badge> : <Button size="sm" onClick={() => navigate(c.to)}>Connect</Button>} />
            ))}
          </List>
        </Section>
        <Section title="All skills" actions={<Button size="sm" onClick={() => setParams({ tab: "add" })}>Copy from a project</Button>}>
          <List className="ag-list" label="All skills">
            {data.skills.map((s) => (
              <Row key={s.id} title={s.name} meta={s.description}
                actions={s.added ? <span className="ag-meta">Added</span> : <Button size="sm" onClick={() => add(s.id)}>Add</Button>} />
            ))}
          </List>
        </Section>
      </>;
    }}</Gate>
  );
}

// ---------------------------------------------------------------------------------------------------- installed
function Installed({ onAdd }: { onAdd: () => void }) {
  const items = useLoad(() => api<HubSkill[]>("/hub/skills").then((r) => r.filter((s) => s.status === "installed" || s.status === "disabled")), []);
  const [open, setOpen] = useState<number | null>(null);
  const [updating, setUpdating] = useState<{ id: number; stages: Record<StageId, StageState>; result?: HubSkill; upToDate?: boolean; error?: string } | null>(null);
  const toast = useToast();
  const load = items.reload;

  const toggle = async (s: HubSkill) => {
    try { await api(`/hub/skills/${s.id}/${s.status === "installed" ? "disable" : "enable"}`, { method: "POST" }); load(); } catch (e) { toast.err(e); }
  };
  const remove = async (s: HubSkill) => {
    if (!confirm(`Uninstall ${s.name}? Its files are deleted; the audit log keeps a record.`)) return;
    try { await api(`/hub/skills/${s.id}`, { method: "DELETE" }); toast.ok(`${s.name} uninstalled`); load(); } catch (e) { toast.err(e); }
  };
  const update = async (s: HubSkill) => {
    let st = blankStages();
    setUpdating({ id: s.id, stages: st });
    try {
      await stream(`/hub/skills/${s.id}/update`, {}, (e) => {
        if (e.error) setUpdating((u) => u && { ...u, error: String(e.error) });
        else if (e.done) setUpdating((u) => u && { ...u, upToDate: !!e.up_to_date, result: e.up_to_date ? undefined : (e.skill as HubSkill) });
        else if (e.stage) { st = { ...st, [e.stage as StageId]: { status: e.status as StageState["status"], detail: String(e.detail ?? "") } }; setUpdating((u) => u && { ...u, stages: st }); }
      });
    } catch (e) { setUpdating((u) => u && { ...u, error: plainError(e) }); }
  };

  return (
    <div>
      <Section title="Added from the internet">
        <Gate state={items} rows={3}>{(list) => list.length === 0 ? (
          <EmptyState icon={<Puzzle size={20} />} title="Nothing added yet" line="Paste a link to a folder of instructions, or search. I check each one before you decide."
            action={<Button variant="primary" icon={<Github size={14} />} onClick={onAdd}>Add a skill</Button>} />
        ) : (
          <div className="sk-list">
            {list.map((s) => {
              const checking = updating?.id === s.id && !updating.result && !updating.upToDate && !updating.error;
              return (
                <div key={s.id} className="sk-item">
                  <div className="sk-item-head">
                    <div className="ag-stack sk-item-text">
                      <div className="ag-bar">
                        <strong className="sk-name">{s.name}</strong>
                        <RiskBadge level={s.risk} />
                        {s.kind === "mcp" && <Badge>Add-on</Badge>}
                        {s.status === "disabled" && <Badge>Off</Badge>}
                      </div>
                      <p className="ag-note">{s.description || "No description"}</p>
                      <details className="sk-advanced">
                        <summary className="faint">Advanced</summary>
                        <p className="ag-meta ag-mono">{s.owner}/{s.repo}{s.path ? `/${s.path}` : ""} @ {s.commit_sha.slice(0, 10)} · installed {relTime(s.installed_at || s.updated_at)}</p>
                      </details>
                      <p className="ag-note">{grantSummary(s.granted)}</p>
                    </div>
                    <div className="ag-bar sk-item-actions">
                      <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => update(s)} busy={checking}>{checking ? "Checking…" : "Check for update"}</Button>
                      <Button size="sm" onClick={() => toggle(s)}>{s.status === "installed" ? "Turn off" : "Turn on"}</Button>
                      <IconButton size="sm" label={`Uninstall ${s.name}`} onClick={() => remove(s)}><Trash2 size={14} /></IconButton>
                    </div>
                  </div>
                  <button type="button" className="sk-link" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Hide report" : "Show security report"}</button>
                  {open === s.id && <ReportView r={s.report} />}
                  {updating?.id === s.id && (
                    <div className="ag-stack ag-gap-top">
                      {updating.upToDate && <p className="ag-note ag-ok">Already up to date with {s.ref}.</p>}
                      {updating.error && <ErrorState title="The update check stopped" line={updating.error} onRetry={() => update(s)} />}
                      {!updating.upToDate && !updating.error && <Stepper stages={updating.stages} />}
                      {updating.result && <Review skill={updating.result} onDone={() => { setUpdating(null); load(); }} />}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}</Gate>
      </Section>
      <Section title="Learned or written here">
        <LearnedSkills />
      </Section>
    </div>
  );
}

function grantSummary(g: Partial<Perms>): string {
  const bits = [
    g.network?.length ? `internet: ${g.network.join(", ")}` : "",
    g.files?.length ? `files: ${g.files.join(", ")}` : "",
    g.env?.length ? `settings: ${g.env.join(", ")}` : "",
    g.shell ? "can run programs" : "",
  ].filter(Boolean);
  return bits.length ? `Allowed ${bits.join(" · ")}` : "No extra access granted. Anything else asks you first.";
}

// ---------------------------------------------------------------------------------------------------- add
function AddFromGitHub({ onInstalled }: { onInstalled: () => void }) {
  const [url, setUrl] = useState("");
  const [stages, setStages] = useState<Record<StageId, StageState> | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [result, setResult] = useState<HubSkill | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<unknown>(null);
  const settings = useLoad(() => api<HubSettings>("/hub/settings"), []);

  const check = async (target: string) => {
    const u = target.trim();
    if (!u || running) return;
    setUrl(u); setChoices(null); setResult(null); setError(""); setRunning(true);
    let st = blankStages();
    setStages(st);
    try {
      await stream("/hub/check", { url: u }, (e) => {
        if (e.error) setError(String(e.error));
        else if (e.done) setResult(e.skill as HubSkill);
        else if (e.stage) {
          st = { ...st, [e.stage as StageId]: { status: e.status as StageState["status"], detail: String(e.detail ?? "") } };
          setStages(st);
          if (e.status === "choose") setChoices(e.choices as Choice[]);
        }
      });
    } catch (e) { setError(plainError(e)); }
    setRunning(false);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); check(url); };
  const runSearch = async () => {
    setSearching(true); setSearchErr(null);
    try { setHits(await api<SearchHit[]>(`/hub/search?q=${encodeURIComponent(q)}`)); } catch (err) { setSearchErr(err); }
    setSearching(false);
  };
  const search = (e: FormEvent) => { e.preventDefault(); runSearch(); };

  return (
    <div className="ag-stack-lg">
      <Card as="section">
        <form className="ag-form" onSubmit={submit}>
          <Input label="Paste a link" className="ag-mono" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false}
            placeholder="A link to a folder on GitHub" hint="A folder of instructions. Nothing is installed until you say so." />
          <div className="ag-bar">
            <Button type="submit" variant="primary" disabled={!url.trim()} busy={running} icon={running ? undefined : <ArrowRight size={14} />}>{running ? "Checking…" : "Check it"}</Button>
          </div>
          <details className="sk-advanced"><summary className="faint">Advanced</summary><p className="ag-note">Accepts a GitHub folder with a SKILL.md, or an MCP server. I scan it and trial-run it before you decide.</p></details>
        </form>
      </Card>

      {stages && (
        <section className="ag-stack" aria-label="Security check">
          <Stepper stages={stages} />
          {error && <ErrorState title="The check stopped" line={error} onRetry={() => check(url)} />}
          {choices && (
            <Section title={`This repository holds ${choices.length} skills. Which one?`}>
              <List className="ag-list">
                {choices.map((c) => <Row key={c.path} title={c.name} meta={<span className="ag-mono">{c.path}</span>} actions={<Button size="sm" onClick={() => check(c.url)}>Check this one</Button>} />)}
              </List>
            </Section>
          )}
          {result && <Review skill={result} onDone={(installed) => { setStages(null); setResult(null); setUrl(""); if (installed) onInstalled(); }} />}
        </section>
      )}

      {!stages && (
        <section className="ag-stack" aria-label="Search for skills">
          <form className="ag-bar" onSubmit={search}>
            <div className="sk-search ag-grow"><Search size={14} aria-hidden="true" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, for example pdf or spreadsheet" aria-label="Search for skills" /></div>
            <Button type="submit" busy={searching}>{searching ? "Searching…" : "Search"}</Button>
          </form>
          {searchErr ? <ErrorState title="The search did not finish" line={plainError(searchErr)} onRetry={runSearch} />
            : hits === null ? (
            <details className="sk-advanced">
              <summary className="faint">Advanced</summary>
              <p className="ag-note">
                {settings.data?.has_token ? "Searching SKILL.md files and repositories tagged agent-skills, claude-skills or mcp-server." : "Searches repositories tagged agent-skills, claude-skills or mcp-server. Add a GitHub token below to search inside repositories too."}
              </p>
            </details>
          ) : hits.length === 0 ? (
            <EmptyState icon={<Search size={20} />} title="Nothing found" line="Try a broader word, or paste the link if you already know where the skill lives." />
          ) : (
            <List className="ag-list" label="Search results">
              {hits.map((h) => (
                <Row key={h.url} title={<>{h.name}{h.kind === "mcp" ? " · Add-on" : ""}{h.stars != null ? ` · ★ ${h.stars}` : ""}</>}
                  meta={<><span className="ag-mono">{h.full_name}{h.path ? `/${h.path}` : ""}</span>{h.description && <><br />{h.description}</>}</>}
                  actions={<>
                    <a className="ui-iconbtn ui-iconbtn-sm" href={h.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub" title="Open on GitHub"><ExternalLink size={14} /></a>
                    <Button size="sm" onClick={() => check(h.url)}>Check</Button>
                  </>} />
              ))}
            </List>
          )}
        </section>
      )}

      {settings.data && <HubSettingsCard settings={settings.data} onSaved={settings.set} />}
    </div>
  );
}

function HubSettingsCard({ settings, onSaved }: { settings: HubSettings; onSaved: (s: HubSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [tok, setTok] = useState("");
  const toast = useToast();
  const save = async (value: string) => {
    try { onSaved(await api<HubSettings>("/hub/settings", { method: "PUT", body: { token: value } })); setTok(""); toast.ok(value ? "Token saved, encrypted" : "Token removed"); } catch (e) { toast.err(e); }
  };
  return (
    <details className="ui-card sk-settings" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><span className="ag-grow">How checking works</span><span className="ag-meta">{settings.has_token ? "GitHub token set" : "No GitHub token"}</span></summary>
      <div className="ag-form ag-gap-top">
        <p className="ag-note">
          Scanners: {settings.scanners.length > 1 ? settings.scanners.join(", ") : "built-in rules only (install semgrep, bandit, gitleaks or osv-scanner and they're used too)"}.
          Sandbox: {settings.isolation.join(", ")}.
        </p>
        <div className="ag-bar sk-token">
          <Input label="GitHub token (optional)" className="ag-mono" type="password" autoComplete="off" value={tok} onChange={(e) => setTok(e.target.value)} placeholder={settings.has_token ? "•••••••• saved" : "Only needs public read access"} />
          <Button icon={<KeyRound size={14} />} disabled={!tok.trim()} onClick={() => save(tok)}>Save</Button>
          {settings.has_token && <Button variant="ghost" onClick={() => save("")}>Remove</Button>}
        </div>
        <p className="ag-note">Raises GitHub's rate limit and lets search look inside repositories. Stored encrypted on this machine.</p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------------- stepper
function Stepper({ stages }: { stages: Record<StageId, StageState> }) {
  return (
    <ol className="sk-steps" aria-label="Security check">
      {STAGES.map((s, i) => {
        const st = stages[s.id];
        return (
          <li key={s.id} className={`sk-step is-${st.status}`} aria-current={st.status === "running" ? "step" : undefined}>
            <span className="sk-num">{st.status === "done" ? <Check size={12} strokeWidth={3} aria-label="Done" /> : i + 1}</span>
            <span className="sk-step-text">
              <span className="sk-step-label">{s.label}</span>
              <span className="sk-step-detail">{st.detail || (st.status === "waiting" ? "Waiting" : st.status === "running" ? "Working" : "")}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------------- review + approve
function Review({ skill, onDone }: { skill: HubSkill; onDone: (installed: boolean) => void }) {
  const r = skill.report;
  const p = r.permissions;
  const phrase = skill.confirm_phrase || `install ${skill.name} anyway`;
  // Access an update newly asks for is never pre-ticked: you opt in to it, like High risk.
  const isNew = (v: string) => !!r.diff?.permissions.some((x) => x.endsWith(`: ${v}`) || (v === "shell" && /shell|program/i.test(x)));
  const [grant, setGrant] = useState<Record<string, boolean>>(() => {
    const g: Record<string, boolean> = {};
    const on = (v: string) => skill.risk !== "high" && !isNew(v);
    p.network.forEach((d) => (g[`network:${d}`] = on(d)));
    p.files.forEach((f) => (g[`files:${f}`] = on(f)));
    p.env.forEach((v) => (g[`env:${v}`] = on(v)));
    p.tools.forEach((t) => (g[`tools:${t}`] = on(t)));
    if (p.shell) g["shell"] = on("shell");
    return g;
  });
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const high = skill.risk === "high";
  const unlocked = !high || typed.trim().toLowerCase() === phrase;

  const install = async () => {
    const pick = (k: string) => Object.entries(grant).filter(([key, v]) => v && key.startsWith(k + ":")).map(([key]) => key.slice(k.length + 1));
    setBusy(true); setErr("");
    try {
      await api(`/hub/skills/${skill.id}/install`, { body: { grants: { network: pick("network"), files: pick("files"), env: pick("env"), tools: pick("tools"), shell: !!grant.shell }, confirm: typed } });
      onDone(true);
    } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  const reject = async () => {
    try { await api(`/hub/skills/${skill.id}/reject`, { method: "POST" }); } catch { /* already gone */ }
    onDone(false);
  };
  const items = useMemo(() => [
    ...p.network.map((d) => ({ key: `network:${d}`, text: `Connect to ${d}`, isNew: isNew(d) })),
    ...p.files.map((f) => ({ key: `files:${f}`, text: `Read or write ${f}`, isNew: isNew(f) })),
    ...p.env.map((v) => ({ key: `env:${v}`, text: `Read the setting ${v}`, isNew: isNew(v) })),
    ...p.tools.map((t) => ({ key: `tools:${t}`, text: `Use the ${t} tool`, isNew: isNew(t) })),
    ...(p.shell ? [{ key: "shell", text: "Run programs and shell commands", isNew: isNew("shell") }] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [p]);

  return (
    <div className={`ui-card ui-card-pad-none sk-review risk-${skill.risk}`}>
      <div className="sk-verdict">
        {high ? <ShieldAlert size={20} aria-hidden="true" /> : <ShieldCheck size={20} aria-hidden="true" />}
        <div className="ag-grow">
          <p className="ag-meta">Security report · {skill.kind === "mcp" ? "Add-on" : "Skill"}</p>
          <h2 className="ag-title"><span className="ag-mono">{skill.name}</span> · {RISK_COPY[skill.risk]}</h2>
        </div>
        <a className="ui-btn ui-btn-ghost ui-btn-sm" href={`https://github.com/${r.source.owner}/${r.source.repo}/tree/${r.source.sha}/${r.source.path}`} target="_blank" rel="noreferrer">
          <Github size={14} aria-hidden="true" /> Source
        </a>
      </div>
      <div className="sk-body">
        {skill.description && <p className="ag-note">{skill.description}</p>}
        <p className="ag-label ag-gap-top">Why {RISK_COPY[skill.risk].split(" ·")[0].toLowerCase()}</p>
        <ul className="sk-reasons">{r.risk.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
        {r.diff && <DiffView d={r.diff} />}
        <ReportView r={r} />
      </div>

      <div className="sk-approve">
        {items.length > 0 ? (
          <fieldset className="sk-grants">
            <legend className="ag-label">Allow it to</legend>
            {items.map((it) => (
              <label key={it.key} className="ag-check">
                <input type="checkbox" checked={!!grant[it.key]} onChange={(e) => setGrant({ ...grant, [it.key]: e.target.checked })} /> {it.text}{it.isNew && <Badge tone="warn">New in this update</Badge>}
              </label>
            ))}
            <p className="ag-note">Anything you leave unticked, or anything it tries that isn't listed, is blocked and asks you first.</p>
          </fieldset>
        ) : r.trial.violations.length ? (
          <p className="ag-note"><Lock size={12} aria-hidden="true" /> Declares no extra access, but its trial run tried more. Those attempts stay blocked; if they happen after install, you'll be asked.</p>
        ) : <p className="ag-note"><Lock size={12} aria-hidden="true" /> Needs no extra access: no internet, no files outside its folder, no programs.</p>}

        {high && (
          <div className="sk-block" role="alert">
            <p className="ag-body"><strong>Blocked by default.</strong> This skill did something dangerous in the checks above.
              If you wrote it or fully trust it, type <code className="ag-mono">{phrase}</code> to override.</p>
            <Input className="ag-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={phrase} aria-label="Type the override phrase" spellCheck={false} />
          </div>
        )}
        {err && <p className="ag-err" role="alert">{err}</p>}
        <div className="ag-bar">
          <Button variant={high ? "danger" : "primary"} disabled={!unlocked} busy={busy} onClick={install}>
            {busy ? "Installing…" : high ? "Install anyway" : skill.update_of ? "Approve update" : "Approve and install"}
          </Button>
          <Button variant="ghost" icon={<X size={14} />} onClick={reject}>{skill.update_of ? "Keep current version" : high ? "Discard" : "Don't install"}</Button>
        </div>
      </div>
    </div>
  );
}

function RiskBadge({ level }: { level: Risk["level"] }) {
  return <Badge tone={level === "high" ? "danger" : level === "medium" ? "warn" : "neutral"}>{level === "high" ? "High risk" : level === "medium" ? "Medium risk" : "Low risk"}</Badge>;
}

const SEV_TONE = { critical: "danger", high: "danger", medium: "warn", low: "neutral" } as const;
const SEV_WORD = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;

function ReportView({ r }: { r: Report }) {
  const findings = [...r.injection.map((f) => ({ ...f, where: "Instructions" })), ...r.static.map((f) => ({ ...f, where: "Code" }))];
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div className="sk-report">
      <div className="ag-two sk-cols">
        <div>
          <p className="ag-label">What it can touch</p>
          <ul className="sk-plain">{r.permissions_plain.map((x) => <li key={x}>{x}</li>)}</ul>
          {r.permissions.undeclared.length > 0 && <p className="ag-err">Not declared by the author: {r.permissions.undeclared.join(", ")}</p>}
        </div>
        <div>
          <p className="ag-label">Sealed trial run · {r.trial.status}</p>
          {r.trial.note && <p className="ag-note">{r.trial.note}</p>}
          {r.trial.runs.length === 0 && !r.trial.note && <p className="ag-note">Instructions only. Nothing to run.</p>}
          {r.trial.runs.map((run, i) => (
            <div key={i} className="sk-run">
              <div className="ag-bar ag-meta"><span className="ag-mono ag-grow">{run.script}</span><span>{run.status === "failed" && !run.violations?.length ? "ran" : run.status}{run.exit != null ? ` · exit ${run.exit}` : ""}</span></div>
              {run.violations.map((v, j) => <p key={j} className="sk-violation"><X size={12} strokeWidth={3} aria-hidden="true" /> Blocked {v.kind.replace("-", " ")}: <span className="ag-mono">{v.target || v.what}</span></p>)}
              {run.stdout.trim() && <pre className="ag-pre">{run.stdout.trim().slice(0, 400)}</pre>}
            </div>
          ))}
        </div>
      </div>
      <p className="ag-label ag-section-gap">Findings · {findings.length || "none"}</p>
      {findings.length > 0 && (
        <ul className="sk-findings">
          {findings.slice(0, 40).map((f, i) => (
            <li key={i}>
              <Badge tone={SEV_TONE[f.severity]}>{SEV_WORD[f.severity]}</Badge>
              <div className="ag-grow">
                <p className="ag-body">{f.message}</p>
                <p className="ag-meta ag-mono">{f.where} · {f.file}{f.line ? `:${f.line}` : ""}{f.tool ? ` · ${f.tool}` : ""}</p>
                {f.snippet && <code className="sk-snippet">{f.snippet}</code>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="ag-note ag-gap-top">Checked {r.files.length} files at {r.source.owner}/{r.source.repo}@{r.source.sha.slice(0, 12)} with {[...new Set(["built-in rules", ...r.scanners])].join(", ")}.</p>
    </div>
  );
}

function DiffView({ d }: { d: Diff }) {
  const none = !d.added.length && !d.removed.length && !d.changed.length;
  return (
    <div className="sk-diff">
      <p className="ag-label">What changed since your version</p>
      {none ? <p className="ag-note">No file changes.</p> : (
        <p className="ag-note">
          {d.added.length > 0 && <>Added {d.added.join(", ")}. </>}
          {d.removed.length > 0 && <>Removed {d.removed.join(", ")}. </>}
          {d.changed.length > 0 && <>Changed {d.changed.join(", ")}.</>}
        </p>
      )}
      {d.permissions.map((x) => <p key={x} className="sk-violation">{x}</p>)}
      {d.patches.map((p, i) => (
        <pre key={i} className="ag-pre sk-patch">{p.split("\n").map((ln, j) => <span key={j} className={ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : ""}>{ln + "\n"}</span>)}</pre>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- activity
const when = (iso: string) => new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z").toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function ActivityTab({ onChange }: { onChange: (n: number) => void }) {
  const reqs = useLoad(() => api<PermRequest[]>("/hub/requests").then((r) => { onChange(r.length); return r; }), []);
  const log = useLoad(() => api<AuditRow[]>("/hub/audit"), []);
  const toast = useToast();
  const decide = async (id: number, allow: boolean) => {
    try { await api(`/hub/requests/${id}/${allow ? "allow" : "deny"}`, { method: "POST" }); reqs.reload(); log.reload(); } catch (e) { toast.err(e); }
  };
  return (
    <div>
      <Section title="Waiting for you">
        <Gate state={reqs} rows={2}>{(list) => list.length === 0
          ? <p className="ag-note">Nothing waiting. When a skill tries something you didn't allow, it's stopped and shows up here.</p>
          : <List className="ag-list" label="Waiting for you">
            {list.map((r) => (
              <Row key={r.id} leading={<ShieldAlert size={16} className="sk-needs" />}
                title={<><span className="ag-mono">{r.skill_name}</span> tried to {r.kind === "network" ? "connect to" : r.kind.replace("-", " ")} <span className="ag-mono">{r.target || r.what}</span></>}
                meta={`${relTime(r.created_at)} · ${r.what}`}
                actions={<><Button size="sm" onClick={() => decide(r.id, true)}>Allow from now on</Button><Button size="sm" variant="ghost" onClick={() => decide(r.id, false)}>Keep blocked</Button></>} />
            ))}
          </List>}
        </Gate>
      </Section>
      <Section title="Audit log">
        <Gate state={log} rows={4}>{(rows) => rows.length === 0
          ? <EmptyState title="Nothing recorded yet" line="Every check, install, update, permission decision and uninstall is recorded here." />
          : <List className="ag-list" label="Audit log">
            {rows.map((a) => <Row key={a.id} title={<>{a.skill_name} <Badge>{a.event}</Badge></>} meta={<>{when(a.created_at)}{a.detail ? ` · ${a.detail}` : ""}</>} />)}
          </List>}
        </Gate>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- learned or written here
type LearnedSkill = { id: number; name: string; description: string; steps: string; uses: number; source: string; enabled: number };

/** Skills written here or learned by the assistant after complex tasks (formerly the chat's Skills tab, which had no route). */
function LearnedSkills() {
  const [items, setItems] = useState<LearnedSkill[] | null>(null);
  const [failed, setFailed] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<LearnedSkill | null>(null);
  const toast = useToast();
  const load = () => api<LearnedSkill[]>("/skills").then((r) => { setItems(r.filter((s) => s.source !== "github")); setFailed(""); })
    .catch((e) => setFailed(plainError(e)));
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!draft) return;
    try {
      if (draft.id) await api(`/skills/${draft.id}`, { method: "PUT", body: { ...draft, enabled: !!draft.enabled } });
      else await api("/skills", { body: { ...draft, enabled: true } });
      setDraft(null); load();
    } catch (e) { toast.err(e); }
  };
  const toggle = async (s: LearnedSkill) => {
    try { await api(`/skills/${s.id}`, { method: "PUT", body: { ...s, enabled: !s.enabled } }); load(); } catch (e) { toast.err(e); }
  };
  const remove = async (s: LearnedSkill) => {
    if (!confirm(`Delete the skill ${s.name}?`)) return;
    try { await api(`/skills/${s.id}`, { method: "DELETE" }); load(); } catch (e) { toast.err(e); }
  };
  return (
    <div className="ag-stack">
      <div className="ag-bar">
        <p className="ag-note ag-grow">Ways of working written here, or learned by the assistant after a long task. Edit, turn off or add your own.</p>
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setDraft({ id: 0, name: "", description: "", steps: "", uses: 0, source: "user", enabled: 1 })}>Add a skill</Button>
      </div>
      {draft && (
        <Card className="ag-stack">
          <Input label="Name" disabled={!!draft.id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="weekly-plan" />
          <Input label="When to use it" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <Textarea label="Steps" rows={8} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} placeholder={"1. ...\n2. ..."} />
          <div className="ag-bar">
            <Button variant="primary" onClick={save}>Save</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </Card>
      )}
      {failed ? <ErrorState title="Skills did not load" line={failed} onRetry={load} />
        : items === null ? <Loading rows={2} />
        : items.length === 0 && !draft ? <EmptyState icon={<BookOpen size={20} />} title="No skills yet" line="Ask for something with several steps, like 'plan my week from my calendar and tasks'." />
        : (
          <List label="Learned or written here">
            {items.map((s) => (
              <Fragment key={s.id}>
                <Row title={s.name} meta={s.description} onClick={() => setOpen(open === s.id ? null : s.id)} active={open === s.id}
                  actions={<><Badge>{s.source === "auto" ? "learned" : "yours"}</Badge><span className="ag-meta">used {s.uses}×</span></>} />
                {open === s.id && (
                  <li className="ag-panel is-sunken ag-stack">
                    <Markdown text={s.steps} />
                    <div className="ag-bar">
                      <Button size="sm" onClick={() => setDraft(s)}>Edit</Button>
                      <Button size="sm" onClick={() => toggle(s)}>{s.enabled ? "Turn off" : "Turn on"}</Button>
                      <IconButton label={`Delete ${s.name}`} onClick={() => remove(s)}><Trash2 size={14} /></IconButton>
                    </div>
                  </li>
                )}
              </Fragment>
            ))}
          </List>
        )}
    </div>
  );
}
