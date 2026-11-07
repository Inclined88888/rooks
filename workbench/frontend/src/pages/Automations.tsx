// Automations: "when this happens, do that", scheduled reports and their inbox. Premium pass (package C): primitives,
// a loading, an empty and an error state for each list, and one column on a phone.
import { CalendarClock, Inbox as InboxIcon, Play, Plus, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Markdown, relTime, useToast } from "../util";
import { Button, Card, EmptyState, IconButton, Input, List, Page, Row, Section, Select, Textarea } from "../ui";
import { Gate, useLoad } from "./agents/kit";
import TriggerAutomations from "../v02/TriggerAutomations"; // feat/v02-automations

type Schedule = { id: number; name: string; cron: string; prompt: string; deliver: string; enabled: number; next_run: string | null; last_run: string | null; last_status: string };
type Item = { id: number; title: string; body: string; source: string; read: number; created_at: string };

const PRESETS = [
  { label: "Plan my day, 7:30", name: "Plan my day", cron: "30 7 * * 1-5",
    prompt: "Plan my day. Check my calendar and what's due. Open each place I've shown you (list_playbooks, then run_playbook for each) and see what's new. Write today in order: what to do, and when. Add anything with a time as a task due today. Do not send mail or pay anyone." },
  { label: "Daily report, 8:00", name: "Daily report", cron: "0 8 * * *",
    prompt: "Write my daily briefing: today's events and due or overdue tasks (use get_agenda), anything you remember I'm working on or waiting for, and 3 suggested priorities. Under 200 words." },
  { label: "Weekly review, Fri 17:00", name: "Weekly review", cron: "0 17 * * 5",
    prompt: "Review my week: completed and still open tasks, what moved forward in our conversations, and what to focus on next week. Under 250 words." },
  { label: "Weekday news, 7:30", name: "Morning news", cron: "30 7 * * 1-5",
    prompt: "Search the web for the most important news in my areas of interest (from memory) and give me 5 bullet points with links." },
];

function OfferWhen() {
  const [when, setWhen] = useState("2");
  const toast = useToast();
  useEffect(() => { api<{ when: string }>("/automations/offer").then((r) => setWhen(r.when)).catch(() => undefined); }, []);
  const pick = async (v: string) => {
    setWhen(v);
    try { await api("/automations/offer", { method: "PUT", body: { when: v } }); }
    catch (e) { toast.err(e); }
  };
  return (
    <div className="au-offer">
      <Select label="Ask to save a task" value={when} onChange={(e) => pick(e.target.value)}>
        <option value="2">After I've done it twice</option>
        <option value="3">After I've done it three times</option>
        <option value="always">Every time</option>
        <option value="off">Don't ask</option>
      </Select>
    </div>
  );
}

function describe(cron: string): string {
  const [m, h, dom, mon, dow] = cron.split(" ");
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : "";
  if (time && dom === "*" && mon === "*") {
    if (dow === "*") return `Every day at ${time}`;
    if (dow === "1-5") return `Weekdays at ${time}`;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    if (/^\d$/.test(dow)) return `Every ${days[Number(dow) % 7]} at ${time}`;
  }
  return cron;
}

export default function Automations() {
  const sched = useLoad(() => api<{ timezone: string; schedules: Schedule[] }>("/schedules"), []);
  const inbox = useLoad(() => api<{ unread: number; items: Item[] }>("/inbox"), []);
  const [form, setForm] = useState({ name: "", cron: "0 8 * * *", prompt: "", deliver: "inbox" });
  const [running, setRunning] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const toast = useToast();

  const load = () => { sched.reload(); inbox.reload(); };
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); load(); } catch (e) { toast.err(e); } };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try { await api("/schedules", { body: form }); setForm({ name: "", cron: "0 8 * * *", prompt: "", deliver: "inbox" }); toast.ok("Scheduled"); load(); }
    catch (err) { toast.err(err); }
  };
  const runNow = async (s: Schedule) => {
    setRunning(s.id);
    try { await api(`/schedules/${s.id}/run`, { method: "POST" }); toast.ok(`${s.name} delivered to the inbox`); }
    catch (e) { toast.err(e); } finally { setRunning(0); load(); }
  };

  return (
    <Page wide className="ag-page au-page" title="Automations"
      description="Show me once where to look, and I can check it each morning. Plan my day opens those places, sees what's new, and writes the plan."
      actions={<OfferWhen />}>
      <TriggerAutomations />{/* feat/v02-automations: "when X happens, do Y" */}

      <Section title="Scheduled reports">
        <Card as="section" aria-label="New scheduled report">
          <form className="ag-form" onSubmit={add}>
            <div className="ag-bar">
              <span className="ag-meta">Quick start:</span>
              {PRESETS.map((p) => <Button size="sm" key={p.label} onClick={() => setForm({ ...form, name: p.name, cron: p.cron, prompt: p.prompt })}>{p.label}</Button>)}
            </div>
            <div className="ag-form-row">
              <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} hint={describe(form.cron)} />
              <Select label="Send it to" value={form.deliver} onChange={(e) => setForm({ ...form, deliver: e.target.value })}>
                <option value="inbox">Inbox</option><option value="telegram">Inbox + Telegram</option>
              </Select>
            </div>
            <Textarea label="What should the assistant do each time?" rows={3} required value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
            <details className="au-advanced">
              <summary>Advanced</summary>
              <Input label="Schedule pattern" className="ag-mono" required value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            </details>
            <div className="ag-bar"><span className="ag-note ag-grow">Each run asks the assistant to do this. Keep ones that run often short.</span><Button type="submit" variant="primary" icon={<Plus size={14} />}>Schedule</Button></div>
          </form>
        </Card>

        <div className="ag-two au-cols ag-section-gap">
          <section aria-labelledby="au-sched-h">
            <div className="ag-bar au-col-head"><CalendarClock size={16} aria-hidden="true" /><h3 id="au-sched-h" className="ag-h3">Schedules</h3></div>
            <Gate state={sched} rows={3}>{(d) => d.schedules.length === 0
              ? <EmptyState icon={<CalendarClock size={20} />} title="Nothing scheduled" line="Try the daily report preset above." />
              : <List className="ag-list" label="Schedules">
                {d.schedules.map((s) => (
                  <Row key={s.id} title={s.name}
                    leading={<input type="checkbox" aria-label={s.enabled ? `Turn off ${s.name}` : `Turn on ${s.name}`} checked={!!s.enabled} onChange={() => act(() => api(`/schedules/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }))} />}
                    meta={<>{describe(s.cron)} · {s.deliver === "telegram" ? "Inbox + Telegram" : "Inbox"}{s.enabled && s.next_run ? ` · next ${new Date(s.next_run).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                      {s.last_status && s.last_status !== "ok" && <span className="ag-err"> · {s.last_status}</span>}</>}
                    actions={<>
                      <Button size="sm" icon={<Play size={14} />} busy={running === s.id} onClick={() => runNow(s)}>{running === s.id ? "Running…" : "Run now"}</Button>
                      <IconButton size="sm" label={`Delete ${s.name}`} onClick={() => { if (confirm(`Delete ${s.name}?`)) act(() => api(`/schedules/${s.id}`, { method: "DELETE" })); }}><Trash2 size={14} /></IconButton>
                    </>} />
                ))}
              </List>}
            </Gate>
          </section>
          <section aria-labelledby="au-inbox-h">
            <div className="ag-bar au-col-head"><InboxIcon size={16} aria-hidden="true" /><h3 id="au-inbox-h" className="ag-h3 ag-grow">Inbox</h3>
              {(inbox.data?.unread ?? 0) > 0 && <Button size="sm" onClick={() => act(() => api("/inbox/read", { method: "POST" }))}>Mark {inbox.data?.unread} read</Button>}</div>
            <Gate state={inbox} rows={3}>{(d) => d.items.length === 0
              ? <EmptyState icon={<InboxIcon size={20} />} title="Nothing here yet" line="Scheduled results show up here." />
              : <List className="ag-list" label="Inbox">
                {d.items.map((i) => (
                  <Row key={i.id} onClick={() => setOpen(open === i.id ? null : i.id)} active={open === i.id}
                    leading={!i.read ? <span className="ag-dot is-live" aria-label="Unread" /> : undefined}
                    title={i.title}
                    meta={open === i.id ? <span className="au-body"><Markdown text={i.body} /></span> : <span className="au-snippet">{relTime(i.created_at)} · {i.body}</span>}
                    actions={<IconButton size="sm" label={`Delete ${i.title}`} onClick={() => act(() => api(`/inbox/${i.id}`, { method: "DELETE" }))}><Trash2 size={14} /></IconButton>} />
                ))}
              </List>}
            </Gate>
          </section>
        </div>
      </Section>
    </Page>
  );
}
