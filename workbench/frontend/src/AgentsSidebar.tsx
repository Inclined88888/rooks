import { CalendarClock, Code2, Menu, Plus, Puzzle, Search, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { relTime } from "./util";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD_KEY = isMac ? "⌘" : "Ctrl";

type Conv = { id: number; title: string; channel: string; updated_at: string; model: string };

/** Cursor Agents Window left sidebar: New Agent, shortcuts, chat list, footer. */
export default function AgentsSidebar({
  workspaceName,
  onSearch,
  onMore,
  onLogout,
  desktop,
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
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let stop = false;
    const load = () => api<Conv[]>(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => { if (!stop) setConvs(r); })
      .catch(() => undefined);
    load();
    const t = window.setInterval(load, 8000);
    return () => { stop = true; clearInterval(t); };
  }, [q, location.key]);

  const remove = async (c: Conv) => {
    if (!confirm(`Delete “${c.title}”?`)) return;
    await api(`/conversations/${c.id}`, { method: "DELETE" });
    setConvs((list) => (list || []).filter((x) => x.id !== c.id));
    if (cid === c.id) navigate("/assistant", { state: { fresh: true } });
  };

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

      <div className="agents-section-label">Chats</div>
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
      <div className="agents-chats">
        {convs === null && <p className="agents-empty">Loading…</p>}
        {convs?.length === 0 && <p className="agents-empty">{q ? "No matches" : "No chats yet"}</p>}
        {convs?.map((c) => (
          <div
            key={c.id}
            className={`agents-chat${c.id === cid ? " active" : ""}`}
            role="link"
            tabIndex={0}
            onClick={() => navigate(`/assistant/${c.id}`)}
            onKeyDown={(e) => { if (e.key === "Enter") navigate(`/assistant/${c.id}`); }}
          >
            <span className="agents-dot" aria-hidden />
            <span className="grow truncate">
              <span className="agents-chat-title truncate">{c.title}</span>
              <span className="agents-chat-meta">{relTime(c.updated_at)}</span>
            </span>
            <button
              type="button"
              className="agents-chat-del"
              aria-label={`Delete ${c.title}`}
              onClick={(e) => { e.stopPropagation(); remove(c); }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="agents-foot">
        <button type="button" className="agents-foot-btn" onClick={onSearch} title={`Search (${MOD_KEY}K)`}>
          <Search size={15} />
        </button>
        <button type="button" className="agents-foot-btn" onClick={onMore} title="More">
          <Menu size={15} />
        </button>
        <Link to="/settings" className="agents-foot-btn" title="Settings" aria-label="Settings">
          <SettingsIcon size={15} />
        </Link>
        <div className="agents-user truncate" title={workspaceName}>{workspaceName}</div>
        {!desktop && onLogout && (
          <button type="button" className="agents-foot-btn" onClick={onLogout} title="Sign out" aria-label="Sign out">
            Out
          </button>
        )}
      </div>
    </aside>
  );
}
