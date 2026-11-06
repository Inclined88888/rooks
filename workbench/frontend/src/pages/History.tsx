/**
 * History: everything the assistant, automations and helpers did, newest first, with one-tap undo (the same history
 * API the result cards in the chat use). Built on the primitives: Undo is a Button, "Can't undo" a Badge with the
 * fix beside it, and each row opens the chat it came from.
 */
import { AlertTriangle, Brain, CalendarDays, Check, CheckSquare, Cog, Download, Eye, FileText, FolderKanban, Globe2, History as HistoryIcon, Mail,
  MessageSquare, Monitor, NotebookPen, Puzzle, ShieldAlert, Undo2, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { Badge, Button, Card, Chip, EmptyState, Input } from "../ui";
import { relTime, SkeletonList, useToast } from "../util";
import "../v02/v02.css";

export type Entry = { id: string; at: string; category: string; who: string; title: string; detail: string; tool: string; conversation_id: number | null;
  status: string; fix: string; fix_prompt: string; undone_at: string | null; undo: { available: boolean; confirm: string; reversible: boolean; note: string } };
type Page = { entries: Entry[]; categories: Record<string, string>; export_allowed: boolean; next_before: string | null };

const ICON: Record<string, typeof Check> = { chat: MessageSquare, note: NotebookPen, task: CheckSquare, calendar: CalendarDays, email: Mail, file: FileText,
  memory: Brain, skill: Puzzle, automation: Workflow, site: Globe2, computer: Monitor, project: FolderKanban, setting: Cog, approval: ShieldAlert, lookup: Eye, other: HistoryIcon };
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
  const [page, setPage] = useState<Page | null>(null);
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [lookups, setLookups] = useState(false);
  const [busy, setBusy] = useState("");
  const [asking, setAsking] = useState<Entry | null>(null);

  const params = useCallback((extra: Record<string, string> = {}) => new URLSearchParams({ ...(cat ? { category: cat } : {}), ...(q ? { q } : {}), ...(lookups ? { lookups: "true" } : {}), ...extra }).toString(), [cat, q, lookups]);
  const load = useCallback(() => api<Page>(`/history?${params()}`).then(setPage).catch(toast.err), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  const more = async () => {
    if (!page?.next_before) return;
    const r = await api<Page>(`/history?${params({ before: page.next_before })}`);
    setPage({ ...r, entries: [...page.entries, ...r.entries] });
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
    <div className="page v02 history-page">
      <div className="page-head">
        <div>
          <div className="v02-kicker">Everything that happened</div>
          <h1>History</h1>
          <p className="muted">What the assistant, your automations and helpers did, newest first. Undo what can be undone in one tap; for the rest, here's how to fix it.</p>
        </div>
        <div className="row">
          <Button size="sm" icon={<Download size={14} />} onClick={() => exportAs("csv")}>Spreadsheet</Button>
          <Button size="sm" icon={<Download size={14} />} onClick={() => exportAs("pdf")}>PDF</Button>
        </div>
      </div>

      <div className="row wrap v02-filters">
        <div className="v02-search">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your history" aria-label="Search your history" />
        </div>
        <div className="v02-chips" role="group" aria-label="Show">
          {FILTERS.map((f) => <Chip key={f} active={cat === f} onClick={() => setCat(f)}>{f ? page?.categories[f] ?? f : "Everything"}</Chip>)}
        </div>
        <label className="row small muted"><input type="checkbox" checked={lookups} onChange={(e) => setLookups(e.target.checked)} /> Include look-ups</label>
      </div>

      {asking && (
        <Card className="v02-confirm" role="alertdialog" aria-label="Confirm undo">
          <AlertTriangle size={18} aria-hidden="true" />
          <div className="grow"><b>Undo “{asking.title}”?</b><div className="small">{asking.undo.confirm}</div></div>
          <Button variant="primary" size="sm" busy={busy === asking.id} onClick={() => void undo(asking, true)}>Yes, undo</Button>
          <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>Keep it</Button>
        </Card>
      )}

      {page === null && <Card><SkeletonList rows={6} /></Card>}
      {page && !page.entries.length && (
        <Card>
          <EmptyState icon={<HistoryIcon size={24} />} title={q || cat ? "Nothing matches." : "Nothing yet."} line={q || cat ? undefined : "When the assistant does something for you, it shows up here."} />
        </Card>
      )}
      {groups.map(([day, rows]) => (
        <section key={day} className="v02-day">
          <h3 className="v02-day-head">{day}</h3>
          <Card padding="none">
            {rows.map((e) => {
              const Icon = ICON[e.category] ?? HistoryIcon;
              return (
                <div key={e.id} className={`v02-entry ${e.status}`}>
                  <span className={`v02-icon c-${e.category}`} aria-hidden="true"><Icon size={14} /></span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="v02-entry-title">{e.title}</div>
                    <div className="small faint v02-entry-meta">{e.who} · {new Date(e.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · {relTime(e.at)}
                      {e.conversation_id && <> · <Link className="v02-link" to={`/assistant/${e.conversation_id}`}>Open chat</Link></>}
                    </div>
                    {e.detail && <div className="small muted v02-detail">{e.detail}</div>}
                    {e.status === "undone" && <div className="small v02-undone"><Undo2 size={12} aria-hidden="true" /> Undone {e.undone_at ? relTime(e.undone_at) : ""}{e.undo.note ? `: ${e.undo.note}` : ""}</div>}
                    {e.status === "undo_failed" && <div className="small v02-late">Couldn't undo: {e.undo.note}</div>}
                    {e.fix && <div className="small v02-fix"><Badge tone="warn">Can't undo</Badge> <span>{e.fix}</span></div>}
                    {e.status === "waiting" && <Link className="small v02-link" to={`/assistant/${e.conversation_id ?? ""}`}>Review it</Link>}
                  </div>
                  <div className="v02-entry-actions">
                    {e.undo.available && <Button size="sm" icon={<Undo2 size={13} />} busy={busy === e.id} onClick={() => (e.undo.confirm ? setAsking(e) : void undo(e))}>Undo</Button>}
                    {e.fix_prompt && <Button size="sm" variant="ghost" onClick={() => navigate("/assistant", { state: { draft: e.fix_prompt } })}>Help me fix it</Button>}
                  </div>
                </div>
              );
            })}
          </Card>
        </section>
      ))}
      {page?.next_before && <div className="row" style={{ justifyContent: "center" }}><Button variant="ghost" onClick={() => void more()}>Show older</Button></div>}
    </div>
  );
}
