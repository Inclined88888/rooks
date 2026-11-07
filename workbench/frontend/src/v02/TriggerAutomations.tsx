// Trigger automations (feat/v02-automations): "When X happens, do Y, ask me first", from plain English or a simple builder.
// Premium pass (package C): built on the primitives; styles in pages/agents/automations.css.
import { ArrowRight, Play, Sparkles, Trash2, Zap } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { relTime, useToast } from "../util";
import { Badge, Button, Card, Chip, EmptyState, IconButton, Input, List, Row, Section, Select, Textarea } from "../ui";
import { Gate, useLoad } from "../pages/agents/kit";
import "../pages/agents/automations.css";
import { AUTOMATION_EXAMPLES } from "./examples";

type Trig = Record<string, unknown>;
export type Automation = {
  id: number; name: string; request: string; trigger_kind: string; trigger: Trig; action_kind: string; action: Trig;
  ask_first: number | boolean; enabled: number | boolean; fired: number; last_fired: string | null; last_error: string | null; last_result: string | null;
  when: string; then: string; sentence: string;
};
type Listing = { automations: Automation[]; limit: number | null; pro: boolean };
type Draft = { name: string; request: string; trigger_kind: string; trigger: Trig; action_kind: string; action: Trig; ask_first: boolean;
  when?: string; then?: string; questions?: string[]; confidence?: number };

const EXAMPLES = AUTOMATION_EXAMPLES;
const TRIGGERS: { v: string; label: string }[] = [
  { v: "email", label: "An email arrives" }, { v: "calendar", label: "A calendar event is coming up" }, { v: "site", label: "A work site changes" },
  { v: "folder", label: "A file appears in a folder" }, { v: "schedule", label: "On a schedule" }, { v: "share", label: "I share something from my phone" },
];
const ACTIONS: { v: string; label: string }[] = [
  { v: "task", label: "Ask the assistant to…" }, { v: "playbook", label: "Run my “Show me how” steps" }, { v: "analyse_file", label: "Read and analyse the file" },
  { v: "draft_email", label: "Draft an email (never sent on its own)" }, { v: "add_event", label: "Add it to my calendar" },
];
const SCHEDULES = [
  { v: "0 8 * * *", label: "Every day at 8:00" }, { v: "0 8 * * 1-5", label: "Weekdays at 8:00" }, { v: "0 17 * * 5", label: "Fridays at 17:00" },
  { v: "0 9 * * 1", label: "Mondays at 9:00" }, { v: "0 * * * *", label: "Every hour" },
];
const BLANK: Draft = { name: "", request: "", trigger_kind: "email", trigger: {}, action_kind: "task", action: {}, ask_first: true };

export default function TriggerAutomations() {
  const listing = useLoad(() => api<Listing>("/automations"), []);
  const data = listing.data;
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [builder, setBuilder] = useState(false);
  const [busy, setBusy] = useState("");
  const [sites, setSites] = useState<{ id: number; name: string }[]>([]);
  const [playbooks, setPlaybooks] = useState<{ id: number; name: string }[]>([]);
  const toast = useToast();

  const load = listing.reload;
  useEffect(() => {
    api<{ sites: { id: number; name: string }[] }>("/sites").then((r) => setSites(r.sites || [])).catch(() => {});
    api<{ id: number; name: string }[]>("/learn/playbooks").then((r) => setPlaybooks(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);

  const parse = async (e?: FormEvent, t = text) => {
    e?.preventDefault();
    if (!t.trim()) return;
    setBusy("parse");
    try { const d = await api<Draft>("/automations/parse", { body: { text: t } }); setDraft(d); setBuilder(false); }
    catch (err) { toast.err(err); } finally { setBusy(""); }
  };
  const save = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      await api("/automations", { body: { name: draft.name, request: draft.request, trigger_kind: draft.trigger_kind, trigger: draft.trigger,
        action_kind: draft.action_kind, action: draft.action, ask_first: draft.ask_first } });
      toast.ok("Automation is on");
      setDraft(null); setText(""); setBuilder(false);
      void load();
    } catch (err) { toast.err(err); } finally { setBusy(""); }
  };
  const patch = async (a: Automation, body: Record<string, unknown>) => {
    try { await api(`/automations/${a.id}`, { method: "PATCH", body }); void load(); } catch (e) { toast.err(e); }
  };
  const remove = async (a: Automation) => {
    if (!confirm(`Delete “${a.name}”?`)) return;
    try { await api(`/automations/${a.id}`, { method: "DELETE" }); void load(); } catch (e) { toast.err(e); }
  };
  const tryNow = async (a: Automation) => {
    setBusy(`try${a.id}`);
    try { await api(`/automations/${a.id}/test`, { method: "POST" }); toast.ok("Test run is on the Jobs board"); void load(); }
    catch (e) { toast.err(e); } finally { setBusy(""); }
  };

  const count = data?.automations.length ?? 0;
  const atLimit = data?.limit != null && count >= data.limit;
  const set = (k: "trigger" | "action", key: string, v: unknown) => setDraft((d) => (d ? { ...d, [k]: { ...d[k], [key]: v } } : d));

  return (
    <Section title="When this happens, do that" actions={data && data.limit != null ? <span className="ag-meta">{count} of {data.limit} on the Free plan · Pro is unlimited</span> : undefined}>
      <div className="ag-stack">
        {!draft && (
          <Card as="section" aria-label="Set up an automation">
            <form className="ag-form" onSubmit={(e) => void parse(e)}>
              <Input label="Say it in your own words" value={text} onChange={(e) => setText(e.target.value)} disabled={atLimit}
                placeholder="When an invoice email arrives, save the PDF to Invoices and add it to my spreadsheet" />
              <div className="ag-bar">
                <Button type="submit" variant="primary" icon={<Sparkles size={14} />} disabled={!text.trim() || atLimit} busy={busy === "parse"}>{busy === "parse" ? "Setting it up…" : "Set it up"}</Button>
                <Button variant="ghost" disabled={atLimit} onClick={() => { setDraft({ ...BLANK }); setBuilder(true); }}>Or build it step by step</Button>
              </div>
              <div className="au-examples" aria-label="Examples">
                {EXAMPLES.map((x) => <Chip key={x} onClick={atLimit ? undefined : () => { setText(x); void parse(undefined, x); }}>{x}</Chip>)}
              </div>
              {atLimit && <p className="ag-note">You've used the {data?.limit} Free automations. Delete one, or go Pro for unlimited.</p>}
            </form>
          </Card>
        )}

        {draft && (
          <Card as="section" className="au-confirm ag-form" aria-label="Check the automation">
            {!builder ? (
              <>
                <Sentence when={draft.when} then={draft.then} />
                {draft.questions && draft.questions.length > 0 && <ul className="au-questions">{draft.questions.map((q) => <li key={q}>{q}</li>)}</ul>}
              </>
            ) : (
              <Builder draft={draft} setDraft={setDraft} set={set} sites={sites} playbooks={playbooks} />
            )}
            <label className="ag-check">
              <input type="checkbox" checked={draft.ask_first} onChange={(e) => setDraft({ ...draft, ask_first: e.target.checked })} />
              <span>Ask me before each run<small>Either way, anything that sends, posts, pays, deletes or changes something outside the app waits for your OK every time.</small></span>
            </label>
            <div className="ag-bar">
              <Button variant="primary" icon={<Zap size={14} />} onClick={() => void save()} busy={busy === "save"}>{busy === "save" ? "Turning it on…" : "Turn it on"}</Button>
              {!builder && <Button variant="ghost" onClick={() => setBuilder(true)}>Change the details</Button>}
              <Button variant="ghost" onClick={() => { setDraft(null); setBuilder(false); }}>Cancel</Button>
            </div>
          </Card>
        )}

        <Gate state={listing} rows={2}>{(l) => l.automations.length === 0
          ? <EmptyState icon={<Zap size={20} />} title="No automations yet" line="Say what should happen in your own words, or pick an example above." />
          : <>
            <List className="ag-list" label="Your automations">
              {l.automations.map((a) => (
                <Row key={a.id} className={a.enabled ? undefined : "au-off"}
                  title={<>{a.name}{!a.enabled && <> <Badge>Off</Badge></>}</>}
                  meta={<>
                    <Sentence when={a.when} then={a.then} small />
                    <span>{a.fired ? `Ran ${a.fired} time${a.fired === 1 ? "" : "s"}, last ${relTime(a.last_fired || "")}` : "Hasn't run yet"}</span>
                    {a.last_error && <span className="ag-err"> · {a.last_error}</span>}
                  </>}
                  actions={<div className="au-controls">
                    <label className="ag-check"><input type="checkbox" checked={!!a.enabled} onChange={(e) => void patch(a, { enabled: e.target.checked })} /> On</label>
                    <label className="ag-check"><input type="checkbox" checked={!!a.ask_first} onChange={(e) => void patch(a, { ask_first: e.target.checked })} /> Ask first</label>
                    <Button size="sm" variant="ghost" icon={<Play size={14} />} busy={busy === `try${a.id}`} onClick={() => void tryNow(a)}>{busy === `try${a.id}` ? "Starting…" : "Try now"}</Button>
                    <IconButton size="sm" label={`Delete ${a.name}`} onClick={() => void remove(a)}><Trash2 size={14} /></IconButton>
                  </div>} />
              ))}
            </List>
            <p className="ag-note">Runs show up on the <Link to="/jobs">Jobs board</Link>.</p>
          </>}
        </Gate>
      </div>
    </Section>
  );
}

function Sentence({ when, then, small }: { when?: string; then?: string; small?: boolean }) {
  return (
    <span className={`au-sentence${small ? " is-small" : ""}`}>
      <span className="au-part"><span className="au-tag">When</span>{when}</span>
      <ArrowRight size={small ? 14 : 16} className="au-arrow" aria-hidden="true" />
      <span className="au-part"><span className="au-tag">Then</span>{then}</span>
    </span>
  );
}

function Builder({ draft, setDraft, set, sites, playbooks }: {
  draft: Draft; setDraft: (d: Draft) => void; set: (k: "trigger" | "action", key: string, v: unknown) => void;
  sites: { id: number; name: string }[]; playbooks: { id: number; name: string }[];
}) {
  const t = draft.trigger;
  const a = draft.action;
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  return (
    <div className="au-builder">
      <div className="ag-form">
        <Select label="When" value={draft.trigger_kind} onChange={(e) => setDraft({ ...draft, trigger_kind: e.target.value, trigger: e.target.value === "schedule" ? { cron: "0 8 * * *" } : e.target.value === "folder" ? { path: "~/Downloads", pattern: "*" } : {} })}>
            {TRIGGERS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
          </Select>
        {draft.trigger_kind === "email" && <>
          <Input label="From (optional)" value={str(t.from)} onChange={(e) => set("trigger", "from", e.target.value)} placeholder="For example accounts@supplier.com" />
          <Input label="Mentions (optional)" value={str(t.words)} onChange={(e) => set("trigger", "words", e.target.value)} placeholder="For example invoice" />
          <label className="ag-check"><input type="checkbox" checked={!!t.attachment} onChange={(e) => set("trigger", "attachment", e.target.checked)} /> Only with an attachment</label>
        </>}
        {draft.trigger_kind === "calendar" && <>
          <Select label="How long before" value={str(t.minutes_before || 15)} onChange={(e) => set("trigger", "minutes_before", Number(e.target.value))}>
            {[5, 10, 15, 30, 60, 120, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 1440 ? "1 day" : `${m / 60} hour${m > 60 ? "s" : ""}`}</option>)}
          </Select>
          <Input label="Only events mentioning (optional)" value={str(t.words)} onChange={(e) => set("trigger", "words", e.target.value)} placeholder="For example client" />
        </>}
        {draft.trigger_kind === "site" && (sites.length
          ? <>
              <Select label="Which site" value={str(t.site_id)} onChange={(e) => set("trigger", "site_id", Number(e.target.value))}>
                <option value="">Pick a site</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              <Select label="What counts" value={str(t.only || "any")} onChange={(e) => set("trigger", "only", e.target.value)}>
                <option value="any">Anything changes</option><option value="added">Something new appears</option><option value="changed">Something changes</option>
              </Select>
            </>
          : <p className="ag-note">Add a site on the <Link to="/sites">Sites</Link> page first.</p>)}
        {draft.trigger_kind === "folder" && <>
          <Input label="Folder" value={str(t.path)} onChange={(e) => set("trigger", "path", e.target.value)} placeholder="~/Downloads" />
          <Select label="Which files" value={str(t.pattern || "*")} onChange={(e) => set("trigger", "pattern", e.target.value)}>
            <option value="*">Any file</option><option value="*.pdf">PDFs</option><option value="*.xlsx,*.xls,*.csv">Spreadsheets</option><option value="*.docx,*.doc">Word documents</option><option value="*.jpg,*.jpeg,*.png,*.heic">Photos</option>
          </Select>
        </>}
        {draft.trigger_kind === "schedule" && <Select label="When" value={str(t.cron)} onChange={(e) => set("trigger", "cron", e.target.value)}>
          {SCHEDULES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          {!SCHEDULES.some((s) => s.v === t.cron) && t.cron ? <option value={str(t.cron)}>{str(t.cron)}</option> : null}
        </Select>}
        {draft.trigger_kind === "share" && <Input label="Only when it mentions (optional)" value={str(t.words)} onChange={(e) => set("trigger", "words", e.target.value)} placeholder="For example recipe" />}
      </div>
      <div className="ag-form">
        <Select label="Then" value={draft.action_kind} onChange={(e) => setDraft({ ...draft, action_kind: e.target.value, action: { prompt: a.prompt } })}>
            {ACTIONS.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
          </Select>
        {draft.action_kind === "playbook"
          ? (playbooks.length
              ? <Select label="Which steps" value={str(a.playbook_id)} onChange={(e) => set("action", "playbook_id", Number(e.target.value))}>
                  <option value="">Pick one</option>{playbooks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              : <p className="ag-note">Teach it something on <Link to="/teach">Show me how</Link> first.</p>)
          : <Textarea label={draft.action_kind === "task" ? "What to do" : "Anything to add (optional)"} rows={3} value={str(a.prompt)} onChange={(e) => set("action", "prompt", e.target.value)}
              placeholder={draft.action_kind === "draft_email" ? "For example: thank them and say I'll reply properly tomorrow" : "For example: save the PDF to Invoices and add a row to my Invoices sheet"} />}
        {draft.action_kind === "draft_email" && <Input label="To (optional)" value={str(a.to)} onChange={(e) => set("action", "to", e.target.value)} placeholder="Leave empty to reply to the sender" />}
        <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="For example Save invoices" />
      </div>
    </div>
  );
}
