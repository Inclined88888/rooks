import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUp, Bell, CalendarClock, CalendarDays, CheckSquare, FolderOpen,
  Inbox, MessageSquare, NotebookPen, Search,
} from "lucide-react";
import { api, CalEvent, Task } from "../api";
import { Button, Chip, EmptyState, ErrorState, IconButton, List, Loading, Menu, Page, Row, Section } from "../ui";
import { fmtTime, Markdown, relTime, todayISO, useToast } from "../util";
import { plainError } from "./day/parts";

type Arrived = { project_id: number; name: string; what: string; kind: string };
type Done = { id: number; title: string; body: string; source: string; created_at: string };
type Dash = { events: CalEvent[]; tasks_due: Task[]; overdue: number; customers?: Arrived[]; assistant_name?: string; arrived?: Done[] };
type Piece = { key: string; line: string; ask: string; note: string };

function dayNote(due: string, today: string) {
  if (due < today) return "Late";
  if (due === today) return "Today";
  return new Date(`${due}T00:00:00`).toLocaleDateString([], { weekday: "short" });
}

const STARTS: { id: string; label: string; text: string; icon: typeof Search }[] = [
  { id: "catchup", label: "Catch me up", text: "Catch me up on my mail, what's due, and anything that changed.", icon: Inbox },
  { id: "day", label: "My day", text: "Plan my day. Check my calendar and what's due, open the places I've shown you and see what's new, then put today in order.", icon: CalendarDays },
  { id: "remind", label: "Remind me", text: "Remind me ", icon: Bell },
  { id: "find", label: "Look it up", text: "Look this up: ", icon: Search },
];

const MORE: { to: string; label: string; icon: typeof Search }[] = [
  { to: "/assistant", label: "Chat", icon: MessageSquare },
  { to: "/mail", label: "Mail", icon: Inbox },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/tasks", label: "Tasks", icon: CheckSquare },
  { to: "/notes", label: "Notes", icon: NotebookPen },
  { to: "/automations", label: "Automations", icon: CalendarClock },
  { to: "/files", label: "Files", icon: FolderOpen },
];

function isToday(iso: string, allDay: boolean) {
  const d = allDay ? new Date(`${iso.slice(0, 10)}T00:00:00`) : new Date(iso);
  return d.toDateString() === new Date().toDateString();
}

function plainWhat(what: string) {
  return what.replace(/^(Mail|Chat):\s*/, "").trim();
}

function pieces(data: Dash, today: string): Piece[] {
  const out: Piece[] = [];
  const seen = new Set<string>();
  const add = (p: Piece) => {
    const k = p.line.toLowerCase();
    if (!p.line || seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  for (const t of data.tasks_due ?? []) {
    if (t.due && t.due < today) add({ key: `late${t.id}`, line: t.title, ask: `${t.title} is late. What should happen now?`, note: "Late" });
  }
  for (const ev of data.events ?? []) {
    if (!isToday(ev.start, !!ev.all_day)) continue;
    const title = ev.title || "Untitled";
    add({ key: `e${ev.id}`, line: title, ask: `Get me ready for ${title}.`, note: ev.all_day ? "Today" : fmtTime(ev.start) });
  }
  for (const t of data.tasks_due ?? []) {
    if (t.due === today) add({ key: `t${t.id}`, line: t.title, ask: t.title, note: "Today" });
  }
  for (const c of data.customers ?? []) {
    const line = plainWhat(c.what);
    const ask = c.kind === "mail" ? `Look at this mail and tell me what it needs: ${line}` : line;
    add({ key: `a${c.project_id}-${c.kind}-${line}`, line, ask, note: c.kind === "mail" ? "Mail" : "New" });
  }
  for (const t of data.tasks_due ?? []) {
    if (!t.due || t.due <= today) continue;
    add({ key: `wait${t.id}`, line: t.title, ask: t.title, note: dayNote(t.due, today) });
  }
  for (const ev of data.events ?? []) {
    if (isToday(ev.start, !!ev.all_day)) continue;
    const title = ev.title || "Untitled";
    add({ key: `later${ev.id}`, line: title, ask: `What's needed for ${title}?`, note: new Date(ev.start).toLocaleDateString([], { weekday: "short" }) });
  }
  return out.slice(0, 6);
}

export default function Dashboard(_: { chatUrl?: string }) {
  const [data, setData] = useState<Dash | null>(null);
  const [problem, setProblem] = useState("");
  const [line, setLine] = useState("");
  const [pill, setPill] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<number | null>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const field = useRef<HTMLInputElement>(null);
  const today = todayISO();

  const load = () => {
    setProblem("");
    return api<Dash>("/dashboard").then(setData).catch((e) => setProblem(plainError(e, "Your day did not load.")));
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const left = data ? pieces(data, today) : [];
  const arrived = (data?.arrived ?? []).filter((item) => item.title);
  const who = data?.assistant_name || "Atlas";
  const asTask = /^add\s+/i.test(line.trim());
  const date = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const heading = "What should {who} do?".replace("{who}", who);
  const didLabel = "{who} already did this".replace("{who}", who);

  const choose = (id: string, text: string) => {
    if (pill === id && line === text) {
      setPill(null);
      setLine("");
      return;
    }
    setPill(id);
    setLine(text);
    field.current?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = line.trim();
    if (!text) return;
    if (asTask) {
      try {
        await api("/tasks", { body: { title: text.replace(/^add\s+/i, ""), due: today } });
        setLine("");
        setPill(null);
        void load();
      } catch (err) {
        toast.err(err);
      }
      return;
    }
    void start(text);
  };

  const start = async (text: string) => {
    try {
      const main = await api<{ id: number }>("/assistant/main");
      navigate(`/assistant/${main.id}`, { state: { draft: text, start: true } });
    } catch (err) {
      toast.err(err);
    }
  };

  return (
    <Page hero title={heading} kicker={date} className="day-page day-home">
      <form className="day-home-ask" onSubmit={submit}>
        <input
          ref={field}
          className="day-home-field"
          value={line}
          onChange={(e) => { setLine(e.target.value); if (pill && !STARTS.some((s) => s.text === e.target.value)) setPill(null); }}
          placeholder="Ask anything, or give it a job"
          aria-label="What should happen"
        />
        <IconButton type="submit" className="day-home-send" label={asTask ? "Add" : "Send"} disabled={!line.trim()}><ArrowUp size={16} /></IconButton>
      </form>

      <div className="day-home-starts" role="group" aria-label="Start with">
        {STARTS.map((s) => (
          <Chip key={s.id} active={pill === s.id} icon={<s.icon size={14} />} onClick={() => choose(s.id, s.text)}>{s.label}</Chip>
        ))}
        <Menu label="More places" align="start" items={MORE.map((item) => ({ id: item.to, label: item.label, icon: <item.icon size={16} />, onSelect: () => navigate(item.to) }))} />
      </div>

      {data === null && !problem && <Loading rows={3} label="Loading your day" />}
      {problem && <ErrorState title="Your day did not load" line={problem} onRetry={() => void load()} />}
      {data && left.length === 0 && arrived.length === 0 && (
        <EmptyState title="Nothing is waiting for you" line="Ask for anything above, or let it plan your day."
          action={<Button size="sm" icon={<CalendarDays size={14} />} onClick={() => choose("day", STARTS[1].text)}>Plan my day</Button>} />
      )}
      {(left.length > 0 || arrived.length > 0) && (
        <div className={left.length > 0 && arrived.length > 0 ? "home-docks day-docks" : "day-docks"}>
          {left.length > 0 && (
            <Section title="Still to do" className="day-dock">
              <List label="Still to do">
                {left.map((p) => (
                  <Row key={p.key} title={p.line} onClick={() => void start(p.ask)} actions={<span className={p.note === "Late" ? "day-when day-danger-text" : "day-when"}>{p.note}</span>} />
                ))}
              </List>
            </Section>
          )}
          {arrived.length > 0 && (
            <Section title={didLabel} className="day-dock">
              <ul className="ui-list" aria-label={didLabel}>
                {arrived.map((item) => (
                  <li key={item.id} className="day-did">
                    <button type="button" className="day-did-main" aria-expanded={openNote === item.id} onClick={() => setOpenNote(openNote === item.id ? null : item.id)}>
                      <span className="day-did-title">{item.title}</span>
                      <span className="day-when">{relTime(item.created_at)}</span>
                    </button>
                    {openNote === item.id
                      ? <div className="day-did-note"><Markdown text={item.body} /></div>
                      : <p className="day-did-note is-short">{item.body}</p>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </Page>
  );
}
