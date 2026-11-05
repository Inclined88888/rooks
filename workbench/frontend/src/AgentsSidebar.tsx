import { Archive, CalendarClock, ChevronDown, ChevronRight, Code2, Monitor, Moon, MoreHorizontal, Plus, Puzzle, Search, Settings as SettingsIcon, Sun, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { isDark, pickTheme, useAppearance } from "./appearance";
import { useToast } from "./util";

type Conv = { id: number; title: string; channel: string; updated_at: string; model: string; archived?: number };
type Project = { id: number; name: string; kind: string; status: string; last_used_at?: string | null; updated_at?: string; counts?: Record<string, number> };
type ProjectList = { projects: Project[]; active_id: number | null };

/** Compact Cursor-style age: 23h, 44m */
function shortAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(diff) || diff < 0) return "";
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 14) return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Cursor Agents Window left sidebar: New Agent, Projects, Repositories/Agents tree, footer. */
export default function AgentsSidebar({
  workspaceName,
  onSearch,
  onMore,
}: {
  workspaceName: string;
  onSearch: () => void;
  onMore: () => void;
  onLogout?: () => void;
  desktop?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [appearance] = useAppearance();
  const dark = isDark(appearance.theme);
  const idMatch = location.pathname.match(/^\/assistant\/(\d+)/);
  const cid = idMatch ? Number(idMatch[1]) : null;
  const projectMatch = location.pathname.match(/^\/projects\/(\d+)/);
  const openProject = projectMatch ? Number(projectMatch[1]) : null;

  const toggleLook = () => {
    pickTheme(dark ? "gallery" : "night");
  };

  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [projects, setProjects] = useState<ProjectList | null>(null);
  const [q, setQ] = useState("");
  const [projOpen, setProjOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [archivedView, setArchivedView] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const toast = useToast();

  const reloadChats = () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (archivedView) params.set("archived", "1");
    const qs = params.toString();
    return api<Conv[]>(`/conversations${qs ? `?${qs}` : ""}`).then(setConvs);
  };

  useEffect(() => {
    let stop = false;
    const load = () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (archivedView) params.set("archived", "1");
      const qs = params.toString();
      api<Conv[]>(`/conversations${qs ? `?${qs}` : ""}`)
        .then((r) => { if (!stop) setConvs(r); })
        .catch(() => undefined);
      api<ProjectList>("/projects")
        .then((r) => { if (!stop) setProjects(r); })
        .catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 10000);
    return () => { stop = true; clearInterval(t); };
  }, [q, location.key, archivedView]);

  const activeProjectId = projects?.active_id ?? null;
  const projectRows = useMemo(() => projects?.projects ?? [], [projects]);

  const initial = (workspaceName || "R").trim().charAt(0).toUpperCase() || "R";
  const filtered = convs ?? [];

  return (
    <aside className="agents-side" aria-label="Agents">
      <div className="agents-side-top">
        <button
          type="button"
          className="agents-new"
          onClick={() => navigate("/assistant", { state: { fresh: true } })}
        >
          <Plus size={15} /> New chat
        </button>
        <nav className="agents-shortcuts">
          {[
            { to: "/automations", label: "Automations", icon: CalendarClock },
            { to: "/customize", label: "Customize", icon: Puzzle },
            { to: "/code", label: "Code", icon: Code2 },
            { to: "/try", label: "Virtual computer", icon: Monitor },
          ].map((item) => (
            <NavLink key={item.to} to={item.to} className="agents-link"><item.icon size={15} /> {item.label}</NavLink>
          ))}
        </nav>
      </div>

      <div className="agents-search-wrap">
        <Search size={13} aria-hidden />
        <input
          className="agents-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search chats"
        />
      </div>

      <div className="agents-tree">
        <button type="button" className="agents-tree-head" onClick={() => setProjOpen((v) => !v)} aria-expanded={projOpen}>
          {projOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Projects</span>
        </button>
        {projOpen && (
          <div className="agents-tree-body">
            {!projectRows.length && (
              <button type="button" className="agents-row" onClick={() => navigate("/projects")}>
                <span className="agents-dot" aria-hidden />
                <span className="grow truncate">
                  <span className="agents-chat-title truncate">{workspaceName || "Home"}</span>
                </span>
              </button>
            )}
            {projectRows.map((p) => {
              const active = p.id === activeProjectId || p.id === openProject;
              const when = shortAgo(p.last_used_at || p.updated_at);
              return (
                <div key={p.id} className={`agents-row${active ? " active" : ""}`}>
                  <button type="button" className="agents-row-open" onClick={() => navigate(`/projects/${p.id}`)}>
                    <span className={`agents-dot${active ? " on" : ""}`} aria-hidden />
                    <span className="grow truncate">
                      <span className="agents-chat-title truncate">{p.name}</span>
                    </span>
                    {when && <span className="agents-age">{when}</span>}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <button type="button" className="agents-tree-head" onClick={() => setChatsOpen((v) => !v)} aria-expanded={chatsOpen}>
          {chatsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Chats</span>
        </button>
        {chatsOpen && (
          <div className="agents-tree-body">
            {convs === null && <p className="agents-empty">Loading…</p>}
            {convs && !filtered.length && (
              <p className="agents-empty">{q ? "No matches" : "No chats yet"}</p>
            )}
            {filtered.map((c) => {
              const active = c.id === cid;
              const open = menuFor === c.id;
              return (
                <div key={c.id} className={`agents-row${active ? " active" : ""}`}>
                  <button type="button" className="agents-row-open" onClick={() => navigate(`/assistant/${c.id}`)}>
                    <span className={`agents-dot${active ? " on" : ""}`} aria-hidden />
                    <span className="grow truncate">
                      <span className="agents-chat-title truncate">{c.title}</span>
                    </span>
                    <span className="agents-age">{shortAgo(c.updated_at)}</span>
                  </button>
                  <div className="agents-chat-menu">
                    <button
                      type="button"
                      className="agents-chat-act"
                      aria-label={`Actions for ${c.title || "chat"}`}
                      aria-expanded={open}
                      onClick={(e) => { e.stopPropagation(); setMenuFor(open ? null : c.id); }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {open && (
                      <div className="agents-chat-pop" role="menu">
                        <button type="button" role="menuitem" onClick={async () => {
                          setMenuFor(null);
                          try {
                            await api(`/conversations/${c.id}`, { method: "PATCH", body: { archived: !archivedView } });
                            if (cid === c.id && !archivedView) navigate("/assistant");
                            await reloadChats();
                          } catch (err) { toast.err(err); }
                        }}>
                          <Archive size={13} /> {archivedView ? "Restore" : "Archive"}
                        </button>
                        <button type="button" role="menuitem" className="danger" onClick={async () => {
                          setMenuFor(null);
                          try {
                            await api(`/conversations/${c.id}`, { method: "DELETE" });
                            if (cid === c.id) navigate("/assistant");
                            await reloadChats();
                          } catch (err) { toast.err(err); }
                        }}>
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <button type="button" className="agents-archived" onClick={() => { setMenuFor(null); setArchivedView((v) => !v); }}>
              {archivedView ? "Back to chats" : "Archived"}
            </button>
          </div>
        )}
      </div>

      <div className="agents-foot">
        <button type="button" className="agents-avatar" onClick={onMore} title="More" aria-label="More">
          {initial}
        </button>
        <button type="button" className="agents-user truncate" onClick={onSearch} title="Search">
          {workspaceName}
        </button>
        <button
          type="button"
          className="agents-foot-btn"
          onClick={toggleLook}
          title={dark ? "Light look" : "Dark look"}
          aria-label={dark ? "Switch to light look" : "Switch to dark look"}
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <Link to="/settings" className="agents-foot-btn" title="Settings" aria-label="Settings">
          <SettingsIcon size={15} />
        </Link>
      </div>
      {toast.node}
    </aside>
  );
}
