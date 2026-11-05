import { CalendarClock, ChevronDown, ChevronRight, Code2, Plus, Puzzle, Search, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";

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

/** Cursor Agents Window left sidebar: New Agent, Projects, Agents tree, footer. */
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
  const idMatch = location.pathname.match(/^\/assistant\/(\d+)/);
  const cid = idMatch ? Number(idMatch[1]) : null;
  const projectMatch = location.pathname.match(/^\/projects\/(\d+)/);
  const openProject = projectMatch ? Number(projectMatch[1]) : null;

  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [projects, setProjects] = useState<ProjectList | null>(null);
  const [q, setQ] = useState("");
  const [projOpen, setProjOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);

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

  return (
    <aside className="agents-side" aria-label="Agents">
      <div className="agents-side-top">
        <button
          type="button"
          className="agents-new"
          onClick={() => navigate("/assistant", { state: { fresh: true } })}
        >
          <Plus size={15} /> New Agent
        </button>
        <nav className="agents-shortcuts">
          <NavLink to="/automations" className="agents-link"><CalendarClock size={15} /> Automations</NavLink>
          <NavLink to="/customize" className="agents-link"><Puzzle size={15} /> Customize</NavLink>
          <NavLink to="/code" className="agents-link"><Code2 size={15} /> Code</NavLink>
        </nav>
      </div>

      <div className="agents-search-wrap">
        <Search size={13} aria-hidden />
        <input
          className="agents-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search agents"
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
                <button
                  key={p.id}
                  type="button"
                  className={`agents-row${active ? " active" : ""}`}
                  onClick={() => navigate(`/projects/${p.id}`)}
                >
                  <span className={`agents-dot${active ? " on" : ""}`} aria-hidden />
                  <span className="grow truncate">
                    <span className="agents-chat-title truncate">{p.name}</span>
                  </span>
                  {when && <span className="agents-age">{when}</span>}
                </button>
              );
            })}
          </div>
        )}

        <button type="button" className="agents-tree-head" onClick={() => setAgentsOpen((v) => !v)} aria-expanded={agentsOpen}>
          {agentsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Agents</span>
        </button>
        {agentsOpen && (
          <div className="agents-tree-body">
            {convs === null && <p className="agents-empty">Loading…</p>}
            {convs?.length === 0 && <p className="agents-empty">{q ? "No matches" : "No agents yet"}</p>}
            {convs?.map((c) => {
              const active = c.id === cid;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`agents-row${active ? " active" : ""}`}
                  onClick={() => navigate(`/assistant/${c.id}`)}
                >
                  <span className={`agents-dot${active ? " on" : ""}`} aria-hidden />
                  <span className="grow truncate">
                    <span className="agents-chat-title truncate">{c.title}</span>
                  </span>
                  <span className="agents-age">{shortAgo(c.updated_at)}</span>
                </button>
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
        <Link to="/settings" className="agents-foot-btn" title="Settings" aria-label="Settings">
          <SettingsIcon size={15} />
        </Link>
      </div>
    </aside>
  );
}
