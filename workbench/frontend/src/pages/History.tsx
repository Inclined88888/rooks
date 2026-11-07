/**
 * History: everything the assistant, automations and helpers did, newest first, with one-tap undo (the same history
 * API the result cards in the chat use). Built on the primitives: Undo is a Button, "Can't undo" a Badge with the
 * fix beside it, and each row opens the chat it came from.
 */
import {
  AlertTriangle, BookMarked, CalendarDays, Check, CheckSquare, Cog, Download, Eye, FileText, FolderKanban, Globe2, History as HistoryIcon, Mail, MessageSquare, Monitor, NotebookPen, Puzzle, ShieldAlert, Undo2, Workflow,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { Badge, Button, Card, Chip, EmptyState, ErrorState, Input, Loading, Page, Section } from "../ui";
import { relTime, useToast } from "../util";
import { CheckField, plainError } from "./day/parts";

export type Entry = { id: string; at: string; category: string; who: string; title: string; detail: string; tool: string; conversation_id: number | null;
  status: string; fix: string; fix_prompt: string; undone_at: string | null; undo: { available: boolean; confirm: string; reversible: boolean; note: string } };
type HistoryPage = { entries: Entry[]; categories: Record<string, string>; export_allowed: boolean; next_before: string | null };

const ICON: Record<string, typeof Check> = { chat: MessageSquare, note: NotebookPen, task: CheckSquare, calendar: CalendarDays, email: Mail, file: FileText,
  memory: BookMarked, skill: Puzzle, automation: Workflow, site: Globe2, computer: Monitor, project: FolderKanban, setting: Cog, approval: ShieldAlert, lookup: Eye, other: HistoryIcon };
const FILTERS = ["", "chat", "note", "task", "calendar", "email", "file", "site", "computer", "automation", "memory", "setting", "approval"];

function dayLabel(iso: string) {
  const d = new Date(iso), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export default function History() {
  const navigate = useNavigate();
  const toast = useToast();
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [problem, setProblem] = useState("");
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [lookups, setLookups] = useState(false);
  const [busy, setBusy] = useState("");
  const [asking, setAsking] = useState<Entry | null>(null);
  // The confirm takes focus when it appears (so it is announced and "Yes, undo" is one key away); Keep it or Escape
  // puts focus back on the entry's own Undo button.
  const yesRef = useRef<HTMLButtonElement>(null);
  const askingId = asking?.id;
  useEffect(() => { if (askingId) yesRef.current?.focus(); }, [askingId]);
  const keepIt = () => {
    const from = asking?.id;
    setAsking(null);
    if (from) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-undo-for="${CSS.escape(String(from))}"]`)?.focus(), 0);
  };

  const params = useCallback((extra: Record<string, string> = {}) => new URLSearchParams({ ...(cat ? { category: cat } : {}), ...(q ? { q } : {}), ...(lookups ? { lookups: "true" } : {}), ...extra }).toString(), [cat, q, lookups]);
  const load = useCallback(() => {
    setProblem("");
    return api<HistoryPage>(`/history?${params()}`).then(setPage).catch((e) => setProblem(plainError(e, "Your history did not load.")));
  }, [params]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  const more = async () => {
    if (!page?.next_before) return;
    try {
      const r = await api<HistoryPage>(`/history?${params({ before: page.next_before })}`);
      setPage({ ...r, entries: [...page.entries, ...r.entries] });
    } catch (e) { toast.err(e); }
  };

  const undo = async (e: Entry, confirmed = false) => {
    setBusy(e.id);
    try {
      const r = await api<Entry>(`/history/${e.id}/undo`, { body: { confirm: confirmed } });
      toast.ok(r.undo.note || "Undone");
      setAsking(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && e.undo.confirm && !confirmed) setAsking(e);
      else toast.err(err);
    } finally { setBusy(""); }
  };

  const exportAs = (fmt: "csv" | "pdf") => {
    // integration/v0.2: export is free on every plan (exports are never gated)
    window.location.href = `/api/history/export.${fmt}?${params()}`;
  };

  const groups: [string, Entry[]][] = [];
  for (const e of page?.entries ?? []) {
    const d = dayLabel(e.at);
    const g = groups[groups.length - 1];
    if (g && g[0] === d) g[1].push(e); else groups.push([d, [e]]);
  }
  return (
    <Page title="History" kicker="Everything that happened" className="day-page"
      description="What the assistant, your automations and helpers did, newest first. Undo what can be undone in one tap; for the rest, here is how to fix it."
      actions={(
        <>
          <Button size="sm" icon={<Download size={14} />} onClick={() => exportAs("csv")}>Spreadsheet</Button>
          <Button size="sm" icon={<Download size={14} />} onClick={() => exportAs("pdf")}>PDF</Button>
        </>
      )}>
      <div className="day-filters">
        <Input className="day-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your history" aria-label="Search your history" />
        <div className="day-chips" role="group" aria-label="Show">
          {FILTERS.map((f) => <Chip key={f} active={cat === f} onClick={() => setCat(f)}>{f ? page?.categories[f] ?? f : "Everything"}</Chip>)}
        </div>
        <CheckField checked={lookups} onChange={setLookups}>Include look-ups</CheckField>
      </div>

      {asking && (
        <Card className="day-confirm" role="alertdialog" aria-label="Confirm undo" aria-describedby="history-confirm-text"
          onKeyDown={(ev: ReactKeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); keepIt(); } }}>
          <AlertTriangle size={18} aria-hidden="true" className="day-warn-icon" />
          <div className="day-grow" id="history-confirm-text"><p className="day-confirm-title">Undo “{asking.title}”?</p><p className="day-hint">{asking.undo.confirm}</p></div>
          <div className="day-actions">
            <Button ref={yesRef} variant="primary" size="sm" busy={busy === asking.id} onClick={() => void undo(asking, true)}>Yes, undo</Button>
            <Button variant="ghost" size="sm" onClick={keepIt}>Keep it</Button>
          </div>
        </Card>
      )}

      {page === null && !problem && <Loading rows={6} label="Loading your history" />}
      {problem && <ErrorState title="History did not load" line={problem} onRetry={() => void load()} />}
      {page && !problem && !page.entries.length && (
        <EmptyState icon={<HistoryIcon size={24} />} title={q || cat ? "Nothing matches." : "Nothing yet."}
          line={q || cat ? "Try other words, or show everything." : "When the assistant does something for you, it shows up here."}
          action={q || cat ? <Button size="sm" onClick={() => { setQ(""); setCat(""); }}>Show everything</Button> : undefined} />
      )}
      {!problem && groups.map(([day, rows]) => (
        <Section key={day} title={day} className="day-history-day">
          <ul className="ui-list" aria-label={day}>
            {rows.map((e) => {
              const Icon = ICON[e.category] ?? HistoryIcon;
              return (
                <li key={e.id} className={`day-entry is-${e.status}`}>
                  <span className="day-entry-icon" aria-hidden="true"><Icon size={14} /></span>
                  <div className="day-entry-text">
                    <p className="day-entry-title">{e.title}</p>
                    <p className="day-entry-meta">{e.who} · {new Date(e.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {relTime(e.at)}
                      {e.conversation_id && <> · <Link className="day-link" to={`/assistant/${e.conversation_id}`}>Open chat</Link></>}
                    </p>
                    {e.detail && <p className="day-entry-detail">{e.detail}</p>}
                    {e.status === "undone" && <p className="day-entry-undone"><Undo2 size={12} aria-hidden="true" /> Undone {e.undone_at ? relTime(e.undone_at) : ""}{e.undo.note ? `: ${e.undo.note}` : ""}</p>}
                    {e.status === "undo_failed" && <p className="day-entry-detail day-danger-text">Couldn't undo: {e.undo.note}</p>}
                    {e.fix && <p className="day-entry-fix"><Badge tone="warn">Can't undo</Badge> <span>{e.fix}</span></p>}
                    {e.status === "waiting" && <Link className="day-link" to={`/assistant/${e.conversation_id ?? ""}`}>Review it</Link>}
                  </div>
                  <div className="day-entry-actions">
                    {e.undo.available && <Button size="sm" data-undo-for={e.id} icon={<Undo2 size={13} />} busy={busy === e.id} onClick={() => (e.undo.confirm ? setAsking(e) : void undo(e))}>Undo</Button>}
                    {e.fix_prompt && <Button size="sm" variant="ghost" onClick={() => navigate("/assistant", { state: { draft: e.fix_prompt } })}>Help me fix it</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
      {page?.next_before && !problem && <div className="day-center"><Button variant="ghost" onClick={() => void more()}>Show older</Button></div>}
    </Page>
  );
}
