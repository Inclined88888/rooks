import { CalendarClock, ChevronDown, ChevronRight, Code2, Monitor, Moon, Plus, Puzzle, Search, Settings as SettingsIcon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { isDark, pickTheme, useAppearance } from "./appearance";
import { BesideButton } from "./Beside";

type Conv = { id: number; title: string; channel: string; updated_at: string; model: string };
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

  useEffect(() => {
    let stop = false;
    const load = () => {
      api<Conv[]>(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then((r) => { if (!stop) setConvs(r); })
        .catch(() => undefined);
      api<ProjectList>("/projects")
        .then((r) => { if (!stop) setProjects(r); })
        .catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 10000);
    return () => { stop = true; clearInterval(t); };
  }, [q, location.key]);

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
            { to: "/try", label: "Practice computer", icon: Monitor },
          ].map((item) => (
            <div key={item.to} className="agents-link-row">
              <NavLink to={item.to} className="agents-link"><item.icon size={15} /> {item.label}</NavLink>
              <BesideButton path={item.to} label={item.label} />
            </div>
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
                  <BesideButton path={`/projects/${p.id}`} label={p.name} />
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
              return (
                <div key={c.id} className={`agents-row${active ? " active" : ""}`}>
                  <button type="button" className="agents-row-open" onClick={() => navigate(`/assistant/${c.id}`)}>
                    <span className={`agents-dot${active ? " on" : ""}`} aria-hidden />
                    <span className="grow truncate">
                      <span className="agents-chat-title truncate">{c.title}</span>
                    </span>
                    <span className="agents-age">{shortAgo(c.updated_at)}</span>
                  </button>
                  <BesideButton path={`/assistant/${c.id}`} label={c.title || "Chat"} />
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
    </aside>
  );
}
