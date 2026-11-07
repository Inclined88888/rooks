import { CalendarDays, ChevronLeft, ChevronRight, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, Calendar, CalEvent } from "../api";
import { Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Select, Sheet, Tabs, Textarea } from "../ui";
import { fmtTime, localDateISO, useToast } from "../util";
import { CALENDAR_COLORS, DEFAULT_CALENDAR_COLOR } from "./day/colors";
import { CheckField, Notice, plainError } from "./day/parts";

const KIND_LABEL: Record<string, string> = { local: "On this computer", ics: "Calendar link", caldav: "Calendar server", google: "Google Calendar", microsoft: "Outlook Calendar" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A calendar's own colour (the person's data) handed to the stylesheet as a variable, never as an inline colour. */
const calVar = (color: string) => ({ "--day-cal": color } as CSSProperties);

function eventDays(ev: CalEvent): [string, string] {
  if (ev.all_day) {
    const end = new Date(`${ev.end}T00:00:00`);
    end.setDate(end.getDate() - 1);
    return [ev.start, localDateISO(end) < ev.start ? ev.start : localDateISO(end)];
  }
  const end = new Date(new Date(ev.end).getTime() - 1);
  return [localDateISO(new Date(ev.start)), localDateISO(end < new Date(ev.start) ? new Date(ev.start) : end)];
}

function ColorPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <fieldset className="day-swatches">
      <legend className="ui-field-label">Colour</legend>
      {CALENDAR_COLORS.map((c) => (
        <label key={c.value} className="day-swatch" title={c.name}>
          <input type="radio" name="calendar-colour" checked={value === c.value} onChange={() => onChange(c.value)} aria-label={c.name} />
          <span className="day-swatch-mark" style={calVar(c.value)} aria-hidden="true" />
        </label>
      ))}
    </fieldset>
  );
}

function AddCalendar({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: "", kind: "ics" as "ics" | "caldav" | "local", url: "", username: "", password: "", color: DEFAULT_CALENDAR_COLOR });
  const [found, setFound] = useState<{ name: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const discover = async () => {
    setBusy(true);
    setError("");
    try {
      setFound(await api("/calendars/discover", { body: { url: form.url, username: form.username, password: form.password } }));
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ error?: string }>("/calendars", { body: form });
      if (r.error) setError(`Added, but the first sync failed: ${r.error}`);
      else onClose();
      onAdded();
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="Add calendar" width={440}>
      <form className="day-form" onSubmit={submit}>
        {error && <Notice tone="danger">{error}</Notice>}
        <Tabs label="Kind of calendar" size="sm" value={form.kind} onChange={(k) => setForm({ ...form, kind: k as typeof form.kind })}
          items={[{ id: "ics", label: "Link (read only)" }, { id: "caldav", label: "Server (two way)" }, { id: "local", label: "On this computer" }]} />
        {form.kind === "ics" && <p className="day-hint">Paste your calendar's private link. Google Calendar: Settings, your calendar, "Secret address in iCal format". Outlook: Settings, Shared calendars, Publish. It refreshes every 15 minutes.</p>}
        {form.kind === "caldav" && <p className="day-hint">Works with Nextcloud, Fastmail, iCloud (use an app specific password), Radicale and Baïkal. Press Find calendars, then pick one.</p>}
        <Input label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        {form.kind !== "local" && <Input label="Web address" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder={form.kind === "ics" ? "Paste the link" : "Your calendar server's address"} />}
        {form.kind === "caldav" && (
          <>
            <div className="day-form-pair">
              <Input label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              <Input label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <Button disabled={!form.url} busy={busy} onClick={discover}>Find calendars</Button>
            {found.map((c) => (
              <CheckField key={c.url} radio="cal" checked={form.url === c.url} onChange={() => setForm({ ...form, url: c.url, name: form.name || c.name })}>{c.name}</CheckField>
            ))}
          </>
        )}
        <ColorPick value={form.color} onChange={(color) => setForm({ ...form, color })} />
        <Button type="submit" variant="primary" busy={busy}>{busy ? "Adding…" : "Add calendar"}</Button>
      </form>
    </Sheet>
  );
}

function AddEvent({ date, calendars, onClose, onAdded }: { date: string; calendars: Calendar[]; onClose: () => void; onAdded: () => void }) {
  const writable = calendars.filter((c) => c.kind !== "ics" && c.enabled);
  const [form, setForm] = useState({ title: "", date, startTime: "09:00", endTime: "10:00", all_day: false, location: "", description: "", attendees: "", calendar_id: writable[0]?.id ?? 0 });
  const target = writable.find((c) => c.id === form.calendar_id);
  const canInvite = !!target && ["google", "microsoft", "caldav"].includes(target.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const iso = (t: string) => new Date(`${form.date}T${t}:00`).toISOString();
      const next = new Date(`${form.date}T00:00:00`);
      next.setDate(next.getDate() + 1);
      await api("/events", {
        body: {
          title: form.title, all_day: form.all_day, location: form.location, description: form.description, calendar_id: form.calendar_id || null,
          attendees: canInvite ? form.attendees.split(/[,;\s]+/).filter((a) => a.includes("@")) : [],
          start: form.all_day ? form.date : iso(form.startTime), end: form.all_day ? localDateISO(next) : iso(form.endTime),
        },
      });
      onAdded();
      onClose();
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title="New event" width={440}>
      <form className="day-form" onSubmit={submit}>
        {error && <Notice tone="danger">{error}</Notice>}
        <Input label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <Input label="Date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        {!form.all_day && (
          <div className="day-form-pair">
            <Input label="Starts" type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
            <Input label="Ends" type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
          </div>
        )}
        <CheckField checked={form.all_day} onChange={(all_day) => setForm({ ...form, all_day })}>All day</CheckField>
        <Input label="Where" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        <Textarea label="Notes" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Select label="Calendar" value={form.calendar_id} onChange={(e) => setForm({ ...form, calendar_id: Number(e.target.value) })}>
          {writable.map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === "caldav" ? " (server)" : c.kind === "google" ? " (Google)" : c.kind === "microsoft" ? " (Microsoft)" : ""}</option>)}
        </Select>
        {canInvite && <Input label="Invite people" hint="Email addresses, separated by commas. They get an invitation." value={form.attendees} onChange={(e) => setForm({ ...form, attendees: e.target.value })} />}
        <Button type="submit" variant="primary" busy={busy}>{busy ? "Saving…" : canInvite && form.attendees.includes("@") ? "Create and send invitations" : "Create event"}</Button>
      </form>
    </Sheet>
  );
}

export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [problem, setProblem] = useState("");
  const [selected, setSelected] = useState(localDateISO(new Date()));
  const [modal, setModal] = useState<"" | "calendar" | "event">("");
  const [syncing, setSyncing] = useState(0);
  const toast = useToast();

  const days = useMemo(() => {
    const first = new Date(cursor);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const start = new Date(first);
    start.setDate(1 - offset);
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [cursor]);

  const loadCalendars = () => api<Calendar[]>("/calendars").then(setCalendars).catch((e) => { setCalendars((c) => c ?? []); setProblem(plainError(e, "Your calendars did not load.")); });
  const loadEvents = () => {
    const start = new Date(days[0]); const end = new Date(days[41]); end.setDate(end.getDate() + 1);
    setProblem("");
    api<CalEvent[]>(`/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`)
      .then(setEvents).catch((e) => { setEvents((v) => v ?? []); setProblem(plainError(e, "Your events did not load.")); });
  };
  useEffect(() => { void loadCalendars(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(loadEvents, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const ev of events ?? []) {
      const [s, e] = eventDays(ev);
      for (const d of days) { const k = localDateISO(d); if (k >= s && k <= e) map.set(k, [...(map.get(k) ?? []), ev]); }
    }
    return map;
  }, [events, days]);

  const sync = async (c: Calendar) => {
    setSyncing(c.id);
    try { const r = await api<{ synced: number }>(`/calendars/${c.id}/sync`, { method: "POST" }); toast.ok(`${c.name}: ${r.synced} events`); loadEvents(); }
    catch (e) { toast.err(e); }
    finally { setSyncing(0); void loadCalendars(); }
  };
  const toggle = async (c: Calendar) => {
    try {
      await api(`/calendars/${c.id}`, { method: "PUT", body: { name: c.name, kind: c.kind, url: c.url, username: c.username, color: c.color, enabled: !c.enabled } });
      void loadCalendars(); loadEvents();
    } catch (e) { toast.err(e); }
  };
  const removeCal = async (c: Calendar) => {
    if (!confirm(`Remove calendar "${c.name}" and its events from this app?`)) return;
    try { await api(`/calendars/${c.id}`, { method: "DELETE" }); void loadCalendars(); loadEvents(); } catch (e) { toast.err(e); }
  };
  const removeEvent = async (ev: CalEvent) => {
    if (!confirm(`Delete "${ev.title}"?`)) return;
    try { await api(`/events/${ev.id}`, { method: "DELETE" }); loadEvents(); } catch (e) { toast.err(e); }
  };

  const today = localDateISO(new Date());
  const month = cursor.getMonth();
  const dayEvents = byDay.get(selected) ?? [];
  const monthName = cursor.toLocaleDateString([], { month: "long", year: "numeric" });
  const selectedName = new Date(`${selected}T00:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  return (
    <Page title="Calendar" description="Your calendars in one place. Double click a day to add an event." wide className="day-page"
      actions={(
        <>
          <Button icon={<Plus size={15} />} onClick={() => setModal("calendar")}>Add calendar</Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setModal("event")} disabled={!calendars}>New event</Button>
        </>
      )}>
      {problem && <ErrorState title="Part of your calendar did not load" line={problem} onRetry={() => { void loadCalendars(); loadEvents(); }} />}
      <div className="day-cal">
        <Card padding="none" className="day-cal-month">
          <div className="day-cal-bar">
            <h2 className="day-cal-name">{monthName}</h2>
            <IconButton label="Previous month" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), month - 1, 1))}><ChevronLeft size={16} /></IconButton>
            <Button size="sm" onClick={() => { const d = new Date(); d.setDate(1); setCursor(d); setSelected(today); }}>Today</Button>
            <IconButton label="Next month" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), month + 1, 1))}><ChevronRight size={16} /></IconButton>
          </div>
          {events === null ? <div className="day-pad"><Loading rows={5} label="Loading your calendar" /></div> : (
            <div className="day-month" role="grid" aria-label={monthName}>
              {WEEKDAYS.map((d) => <div key={d} className="day-dow" role="columnheader">{d}</div>)}
              {days.map((d) => {
                const k = localDateISO(d);
                const list = byDay.get(k) ?? [];
                const cls = ["day-cell", d.getMonth() !== month && "is-other", k === today && "is-today", list.length > 0 && "has-events", k === selected && "is-selected"].filter(Boolean).join(" ");
                return (
                  <button key={k} type="button" role="gridcell" className={cls} aria-selected={k === selected}
                    aria-label={`${d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}${list.length ? `, ${list.length} event${list.length === 1 ? "" : "s"}` : ""}`}
                    onClick={() => setSelected(k)} onDoubleClick={() => { setSelected(k); setModal("event"); }}>
                    <span className="day-cell-n">{d.getDate()}</span>
                    {list.slice(0, 3).map((ev) => (
                      <span key={`${ev.id}-${k}`} className="day-ev" style={calVar(ev.color)}>{!ev.all_day && <span className="day-ev-time">{fmtTime(ev.start)} </span>}{ev.title}</span>
                    ))}
                    {list.length > 3 && <span className="day-ev-more">{list.length - 3} more</span>}
                  </button>
                );
              })}
            </div>
          )}
        </Card>
        <div className="day-cal-side">
          <Section title={selectedName}>
            {events === null ? <Loading rows={2} label="Loading the day" /> : dayEvents.length === 0 ? (
              <EmptyState className="day-empty-sm" title="Nothing on this day" action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setModal("event")} disabled={!calendars}>New event</Button>} />
            ) : (
              <List label={`Events on ${selectedName}`}>
                {dayEvents.map((ev) => (
                  <Row key={ev.id} leading={<span className="day-dot is-cal" style={calVar(ev.color)} />} title={ev.title || "(untitled)"}
                    meta={`${ev.all_day ? "All day" : `${fmtTime(ev.start)} to ${fmtTime(ev.end)}`}${ev.location ? ` · ${ev.location}` : ""} · ${ev.calendar_name}`}
                    actions={ev.calendar_kind === "local" ? <IconButton label={`Delete ${ev.title || "event"}`} size="sm" onClick={() => void removeEvent(ev)}><Trash2 size={14} /></IconButton> : undefined} />
                ))}
              </List>
            )}
          </Section>
          <Section title="Calendars">
            {calendars === null ? <Loading rows={2} label="Loading your calendars" /> : calendars.length === 0 ? (
              <EmptyState className="day-empty-sm" icon={<CalendarDays size={20} />} title="No calendars yet" action={<Button size="sm" onClick={() => setModal("calendar")}>Add calendar</Button>} />
            ) : (
              <List label="Calendars">
                {calendars.map((c) => (
                  <Row key={c.id} className={c.enabled ? undefined : "day-off"} leading={<span className="day-dot is-cal" style={calVar(c.color)} />} title={c.name}
                    meta={<>{KIND_LABEL[c.kind] ?? c.kind}{c.last_synced ? ` · synced ${new Date(c.last_synced).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}{syncing === c.id ? " · syncing…" : ""}
                      {c.last_error && <span className="day-danger-text"> · {c.last_error}</span>}</>}
                    actions={(
                      <>
                        <CheckField className="day-check-sm" checked={!!c.enabled} onChange={() => void toggle(c)}><span className="sr-only">Show {c.name}</span></CheckField>
                        {c.kind !== "local" && <IconButton label="Sync now" size="sm" disabled={syncing === c.id} onClick={() => void sync(c)}><RefreshCw size={14} /></IconButton>}
                        {c.kind === "google" || c.kind === "microsoft"
                          ? <Link className="ui-iconbtn ui-iconbtn-sm" to="/settings#mail" title="Connected account: manage in Settings" aria-label="Manage in Settings"><Settings2 size={14} /></Link>
                          : <IconButton label={`Remove ${c.name}`} size="sm" onClick={() => void removeCal(c)}><Trash2 size={14} /></IconButton>}
                      </>
                    )} />
                ))}
              </List>
            )}
          </Section>
        </div>
      </div>
      {modal === "calendar" && <AddCalendar onClose={() => setModal("")} onAdded={() => { void loadCalendars(); loadEvents(); }} />}
      {modal === "event" && <AddEvent date={selected} calendars={calendars ?? []} onClose={() => setModal("")} onAdded={loadEvents} />}
    </Page>
  );
}
