import { Archive, CheckSquare, ChevronDown, ChevronRight, Code2, Mail, Moon, MoreHorizontal, Plus, Puzzle, Search, Settings as SettingsIcon, Sun, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { isDark, pickTheme, useAppearance } from "./appearance";
import { useTerminalSnap } from "./terminalHost";
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

const PLACE_KEY = "aiw.recent-places";
const PLACES: { id: string; label: string; to: string; test: (path: string) => boolean }[] = [
  { id: "terminal", label: "Terminal", to: "/terminal", test: (p) => p.startsWith("/terminal") },
  { id: "code", label: "Code", to: "/code", test: (p) => p.startsWith("/code") },
  { id: "mail", label: "Mail", to: "/mail", test: (p) => p.startsWith("/mail") },
  { id: "tasks", label: "Tasks", to: "/tasks", test: (p) => p.startsWith("/tasks") },
  { id: "browser", label: "Browser", to: "/browser", test: (p) => p.startsWith("/browser") },
  { id: "computer", label: "Computer", to: "/computer", test: (p) => p.startsWith("/computer") },
];

type PlaceVisit = { id: string; at: string };

function readPlaces(): PlaceVisit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => p && typeof p.id === "string" && typeof p.at === "string").slice(0, 12);
  } catch {
    return [];
  }
}

function sameDay(iso: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

/** Left side: a new chat, what you used lately, then projects. */
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
  const [places, setPlaces] = useState<PlaceVisit[]>(() => readPlaces());
  const terminals = useTerminalSnap();
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

  useEffect(() => {
    const hit = PLACES.find((p) => p.test(location.pathname));
    if (!hit) return;
    setPlaces((prev) => {
      const next = [{ id: hit.id, at: new Date().toISOString() }, ...prev.filter((p) => p.id !== hit.id)].slice(0, 12);
      localStorage.setItem(PLACE_KEY, JSON.stringify(next));
      return next;
    });
  }, [location.pathname]);

  const activeProjectId = projects?.active_id ?? null;
  const projectRows = useMemo(() => projects?.projects ?? [], [projects]);

  const initial = (workspaceName || "R").trim().charAt(0).toUpperCase() || "R";
  const filtered = convs ?? [];
  const openShells = terminals.panes.length;
  const placeRows = places
    .map((visit) => ({ visit, def: PLACES.find((p) => p.id === visit.id) }))
    .filter((row): row is { visit: PlaceVisit; def: (typeof PLACES)[number] } => !!row.def)
    .filter((row) => !(row.def.id === "terminal" && openShells > 0));
  const todayChats = filtered.filter((c) => sameDay(c.updated_at));
  const earlierChats = filtered.filter((c) => !sameDay(c.updated_at));
  const todayPlaces = placeRows.filter((row) => sameDay(row.visit.at));
  const earlierPlaces = placeRows.filter((row) => !sameDay(row.visit.at));

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
            { to: "/mail", label: "Mail", icon: Mail },
            { to: "/tasks", label: "Tasks", icon: CheckSquare },
            { to: "/code", label: "Code", icon: Code2 },
            { to: "/customize", label: "Customize", icon: Puzzle },
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
        <button type="button" className="agents-tree-head" onClick={() => setChatsOpen((v) => !v)} aria-expanded={chatsOpen}>
          {chatsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Recent</span>
        </button>
        {chatsOpen && (
          <div className="agents-tree-body">
            {openShells > 0 && (
              <button type="button" className={`agents-row${location.pathname.startsWith("/terminal") ? " active" : ""}`} onClick={() => navigate("/terminal")}>
                <span className="agents-dot on" aria-hidden />
                <span className="grow truncate">
                  <span className="agents-chat-title truncate">Terminal</span>
                  <span className="agents-chat-meta">{openShells === 1 ? "1 still open" : `${openShells} still open`}</span>
                </span>
              </button>
            )}
            {convs === null && <p className="agents-empty">Loading…</p>}
            {convs && !filtered.length && !todayPlaces.length && !earlierPlaces.length && openShells === 0 && (
              <p className="agents-empty">{q ? "No matches" : "No chats yet"}</p>
            )}
            {(todayChats.length > 0 || todayPlaces.length > 0) && <div className="agents-context-label">Today</div>}
            {todayPlaces.map((row) => (
              <button key={row.def.id} type="button" className="agents-row" onClick={() => navigate(row.def.to)}>
                <span className="agents-dot" aria-hidden />
                <span className="grow truncate"><span className="agents-chat-title truncate">{row.def.label}</span></span>
                <span className="agents-age">{shortAgo(row.visit.at)}</span>
              </button>
            ))}
            {todayChats.map((c) => {
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
            {(earlierChats.length > 0 || earlierPlaces.length > 0) && <div className="agents-context-label">Earlier</div>}
            {earlierPlaces.map((row) => (
              <button key={row.def.id} type="button" className="agents-row" onClick={() => navigate(row.def.to)}>
                <span className="agents-dot" aria-hidden />
                <span className="grow truncate"><span className="agents-chat-title truncate">{row.def.label}</span></span>
                <span className="agents-age">{shortAgo(row.visit.at)}</span>
              </button>
            ))}
            {earlierChats.map((c) => {
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
