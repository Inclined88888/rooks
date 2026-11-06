import { Archive, ChevronDown, ChevronRight, MoreHorizontal, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useFocusTrap, useToast } from "../ui";
import "./chat.css";

type Conv = { id: number; title: string; channel: string; updated_at: string; model: string; archived?: number };
type Project = { id: number; name: string; kind: string; status: string; last_used_at?: string | null; updated_at?: string; counts?: Record<string, number> };
type ProjectList = { projects: Project[]; active_id: number | null };

/** Compact age: 23h, 44m */
export function shortAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(diff) || diff < 0) return "";
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 14) return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sameDay(iso: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

/** One row: the chat, its age, and a small actions menu that is reachable by keyboard and on touch. */
function ChatRow({ c, active, archivedView, onOpen, onArchive, onDelete }: {
  c: Conv; active: boolean; archivedView: boolean; onOpen: () => void; onArchive: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useFocusTrap(pop, open, close);
  return (
    <div className={`chatlist-row${active ? " is-active" : ""}`}>
      <button type="button" className="chatlist-open" onClick={onOpen} aria-current={active ? "page" : undefined}>
        <span className={`chatlist-dot${active ? " on" : ""}`} aria-hidden="true" />
        <span className="chatlist-title truncate">{c.title || "Untitled chat"}</span>
        <span className="chatlist-age">{shortAgo(c.updated_at)}</span>
      </button>
      <div className="chatlist-menu">
        <button type="button" className="chatlist-act" aria-label={`Actions for ${c.title || "chat"}`} aria-haspopup="menu" aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
        {open && (
          <div ref={pop} className="chatlist-pop" role="menu" tabIndex={-1}>
            <button type="button" role="menuitem" onClick={() => { close(); onArchive(); }}><Archive size={13} aria-hidden="true" /> {archivedView ? "Restore" : "Archive"}</button>
            <button type="button" role="menuitem" className="is-danger" onClick={() => { close(); onDelete(); }}><Trash2 size={13} aria-hidden="true" /> Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Chats column of the Chat page (what the old sidebar listed): a new chat, search, recent chats (today and
 * earlier, with archive and delete), the archive, and projects with the active one marked. Polls every 10 s
 * while it is open.
 */
export function ChatList({ open, id = "chat-list" }: { open: boolean; id?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const idMatch = location.pathname.match(/^\/assistant\/(\d+)/);
  const cid = idMatch ? Number(idMatch[1]) : null;
  const projectMatch = location.pathname.match(/^\/projects\/(\d+)/);
  const openProject = projectMatch ? Number(projectMatch[1]) : null;

  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [projects, setProjects] = useState<ProjectList | null>(null);
  const [q, setQ] = useState("");
  const [projOpen, setProjOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [archivedView, setArchivedView] = useState(false);

  const query = () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (archivedView) params.set("archived", "1");
    const qs = params.toString();
    return `/conversations${qs ? `?${qs}` : ""}`;
  };
  const reloadChats = () => api<Conv[]>(query()).then(setConvs);

  useEffect(() => {
    if (!open) return;
    let stop = false;
    const load = () => {
      api<Conv[]>(query()).then((r) => { if (!stop) setConvs(r); }).catch(() => undefined);
      api<ProjectList>("/projects").then((r) => { if (!stop) setProjects(r); }).catch(() => undefined);
    };
    load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 10000);
    return () => { stop = true; clearInterval(t); };
  }, [q, location.key, archivedView, open]);

  const activeProjectId = projects?.active_id ?? null;
  const projectRows = useMemo(() => projects?.projects ?? [], [projects]);
  const filtered = convs ?? [];
  const todayChats = filtered.filter((c) => sameDay(c.updated_at));
  const earlierChats = filtered.filter((c) => !sameDay(c.updated_at));

  const archive = async (c: Conv) => {
    try {
      await api(`/conversations/${c.id}`, { method: "PATCH", body: { archived: !archivedView } });
      if (cid === c.id && !archivedView) navigate("/assistant");
      await reloadChats();
    } catch (err) { toast.err(err); }
  };
  const remove = async (c: Conv) => {
    try {
      await api(`/conversations/${c.id}`, { method: "DELETE" });
      if (cid === c.id) navigate("/assistant");
      await reloadChats();
    } catch (err) { toast.err(err); }
  };
  const rows = (list: Conv[]) => list.map((c) => (
    <ChatRow key={c.id} c={c} active={c.id === cid} archivedView={archivedView} onOpen={() => navigate(`/assistant/${c.id}`)} onArchive={() => archive(c)} onDelete={() => remove(c)} />
  ));

  return (
    <aside id={id} className={`chatlist${open ? " is-open" : ""}`} aria-label="Chats and projects" hidden={!open}>
      <div className="chatlist-top">
        <button type="button" className="chatlist-new" onClick={() => navigate("/assistant", { state: { fresh: true } })}>
          <Plus size={15} aria-hidden="true" /> New chat
        </button>
        <div className="chatlist-search-wrap">
          <Search size={13} aria-hidden="true" />
          <input className="chatlist-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search chats" />
        </div>
      </div>
      <div className="chatlist-tree">
        <button type="button" className="chatlist-head" onClick={() => setChatsOpen((v) => !v)} aria-expanded={chatsOpen}>
          {chatsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span>{archivedView ? "Archived" : "Recent"}</span>
        </button>
        {chatsOpen && (
          <div className="chatlist-body">
            {convs === null && <p className="chatlist-empty">Loading…</p>}
            {convs && !filtered.length && <p className="chatlist-empty">{q ? "No matches" : archivedView ? "Nothing archived" : "No chats yet"}</p>}
            {todayChats.length > 0 && <div className="chatlist-label">Today</div>}
            {rows(todayChats)}
            {earlierChats.length > 0 && <div className="chatlist-label">Earlier</div>}
            {rows(earlierChats)}
            <button type="button" className="chatlist-archived" onClick={() => setArchivedView((v) => !v)}>
              {archivedView ? "Back to chats" : "Archived"}
            </button>
          </div>
        )}
        {projectRows.length > 0 && (
          <button type="button" className="chatlist-head" onClick={() => setProjOpen((v) => !v)} aria-expanded={projOpen}>
            {projOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            <span>Projects</span>
          </button>
        )}
        {projOpen && projectRows.length > 0 && (
          <div className="chatlist-body">
            {projectRows.map((p) => {
              const active = p.id === activeProjectId || p.id === openProject;
              const when = shortAgo(p.last_used_at || p.updated_at);
              return (
                <div key={p.id} className={`chatlist-row${active ? " is-active" : ""}`}>
                  <button type="button" className="chatlist-open" onClick={() => navigate(`/projects/${p.id}`)} aria-current={p.id === openProject ? "page" : undefined}>
                    <span className={`chatlist-dot${active ? " on" : ""}`} aria-hidden="true" />
                    <span className="chatlist-title truncate">{p.name}</span>
                    {p.id === activeProjectId && <span className="sr-only">, active project</span>}
                    {when && <span className="chatlist-age">{when}</span>}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
