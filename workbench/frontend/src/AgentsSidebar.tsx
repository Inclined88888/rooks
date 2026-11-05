import { CalendarClock, ChevronDown, ChevronRight, Code2, Moon, Plus, Puzzle, Search, Settings as SettingsIcon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { isDark, pickTheme, useAppearance } from "./appearance";

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
  const [reposOpen, setReposOpen] = useState(true);
  const [openRepos, setOpenRepos] = useState<Record<string, boolean>>({});

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

  /** Repositories = project (or workspace) groups with agent threads underneath. */
  const repoGroups = useMemo(() => {
    const groups = projectRows.length
      ? projectRows.map((p) => ({ key: `p-${p.id}`, id: p.id, name: p.name, when: shortAgo(p.last_used_at || p.updated_at) }))
      : [{ key: "ws", id: null as number | null, name: workspaceName || "Home", when: "" }];
    return groups;
  }, [projectRows, workspaceName]);

  useEffect(() => {
    setOpenRepos((prev) => {
      const next = { ...prev };
      for (const g of repoGroups) {
        if (next[g.key] === undefined) next[g.key] = true;
      }
      return next;
    });
  }, [repoGroups]);

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

        <button type="button" className="agents-tree-head" onClick={() => setReposOpen((v) => !v)} aria-expanded={reposOpen}>
          {reposOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>Repositories</span>
        </button>
        {reposOpen && (
          <div className="agents-tree-body">
            {convs === null && <p className="agents-empty">Loading…</p>}
            {convs && !filtered.length && !repoGroups.length && (
              <p className="agents-empty">{q ? "No matches" : "No agents yet"}</p>
            )}
            {repoGroups.map((g, gi) => {
              const expanded = openRepos[g.key] !== false;
              const activeRepo = g.id != null && (g.id === activeProjectId || g.id === openProject);
              // Show all agents under the active/first repo; other repos stay as folders until opened with their project.
              const showAgents = gi === 0 || (g.id != null && g.id === activeProjectId);
              const agentsHere = showAgents ? filtered : [];
              return (
                <div key={g.key} className="agents-repo">
                  <button
                    type="button"
                    className={`agents-row agents-repo-head${activeRepo ? " active" : ""}`}
                    onClick={() => setOpenRepos((m) => ({ ...m, [g.key]: !expanded }))}
                  >
                    {expanded ? <ChevronDown size={13} className="agents-repo-chev" /> : <ChevronRight size={13} className="agents-repo-chev" />}
                    <span className={`agents-dot${activeRepo ? " on" : ""}`} aria-hidden />
                    <span className="grow truncate">
                      <span className="agents-chat-title truncate">{g.name}</span>
                    </span>
                    {g.when && <span className="agents-age">{g.when}</span>}
                  </button>
                  {expanded && (
                    <div className="agents-repo-agents">
                      {!agentsHere.length && showAgents && (
                        <p className="agents-empty">{q ? "No matches" : "No agents yet"}</p>
                      )}
                      {agentsHere.map((c) => {
                        const active = c.id === cid;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            className={`agents-row agents-agent-row${active ? " active" : ""}`}
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
