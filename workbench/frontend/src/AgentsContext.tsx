import { FolderOpen, Globe, Monitor, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "./api";

type Job = { id: string; goal?: string; task?: string; status: string; agent_name?: string; created_at?: number };
type Tab = { id: string; label: string; to: string; on: boolean };

function shortAgoTs(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

/** Cursor-style right context: Open Tabs + work on this workspace + surface foot. */
export default function AgentsContext({
  workspaceName,
  browserEnabled,
  deskEnabled,
}: {
  workspaceName: string;
  browserEnabled?: boolean;
  deskEnabled?: boolean;
}) {
  const location = useLocation();
  const [runs, setRuns] = useState<Job[]>([]);
  const [desk, setDesk] = useState<Job[]>([]);
  const [browser, setBrowser] = useState<Job[]>([]);

  useEffect(() => {
    let stop = false;
    const load = () => {
      api<Job[]>("/cli-agents/runs").then((r) => { if (!stop) setRuns(r.slice(0, 8)); }).catch(() => undefined);
      if (deskEnabled) api<Job[]>("/desk/jobs").then((r) => { if (!stop) setDesk(r.slice(0, 6)); }).catch(() => undefined);
      if (browserEnabled) api<Job[]>("/browser/jobs").then((r) => { if (!stop) setBrowser(r.slice(0, 6)); }).catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 12000);
    return () => { stop = true; clearInterval(t); };
  }, [deskEnabled, browserEnabled, location.key]);

  const path = location.pathname;
  const tabs: Tab[] = [
    { id: "browser", label: "Browser", to: "/browser", on: path.startsWith("/browser") || browser.some((j) => j.status === "running" || j.status === "queued") },
    { id: "computer", label: "Computer", to: "/computer", on: path.startsWith("/computer") || desk.some((j) => j.status === "running" || j.status === "queued" || j.status === "waiting") },
    { id: "terminal", label: "Terminal", to: "/terminal", on: path.startsWith("/terminal") },
    { id: "code", label: "Code", to: "/code", on: path.startsWith("/code") },
  ].filter((t) => {
    if (t.id === "browser" && browserEnabled === false) return false;
    if (t.id === "computer" && !deskEnabled) return path.startsWith("/computer");
    return true;
  });

  const work = [
    ...runs.map((r) => ({
      key: `run-${r.id}`,
      title: r.task || r.goal || "Code job",
      meta: [r.agent_name, shortAgoTs(r.created_at)].filter(Boolean).join(" · "),
      to: `/code/${r.id}`,
      live: r.status === "running" || r.status === "queued" || r.status === "needs_approval",
    })),
    ...desk.map((j) => ({
      key: `desk-${j.id}`,
      title: j.goal || "Computer",
      meta: shortAgoTs(j.created_at) || j.status,
      to: `/computer/${j.id}`,
      live: j.status === "running" || j.status === "queued" || j.status === "waiting",
    })),
    ...browser.map((j) => ({
      key: `br-${j.id}`,
      title: j.goal || "Browser",
      meta: shortAgoTs(j.created_at) || j.status,
      to: `/browser/${j.id}`,
      live: j.status === "running" || j.status === "queued",
    })),
  ].slice(0, 10);

  return (
    <aside className="agents-context" aria-label="Context">
      <div className="agents-context-scroll">
        <div className="agents-context-label">Open tabs</div>
        <div className="agents-tabs">
          {tabs.map((t) => (
            <Link key={t.id} to={t.to} className={`agents-tab${t.on ? " on" : ""}`}>
              <span className={`agents-dot${t.on ? " on" : ""}`} aria-hidden />
              <span className="truncate">{t.label}</span>
            </Link>
          ))}
          {!tabs.length && <p className="agents-empty">Nothing open</p>}
        </div>

        <div className="agents-context-label">On {workspaceName || "this computer"}</div>
        <div className="agents-work">
          {!work.length && <p className="agents-empty">Recent jobs show up here</p>}
          {work.map((w) => (
            <Link key={w.key} to={w.to} className={`agents-work-row${w.live ? " live" : ""}`}>
              <span className={`agents-dot${w.live ? " on" : ""}`} aria-hidden />
              <span className="grow truncate">
                <span className="agents-chat-title truncate">{w.title}</span>
                {w.meta && <span className="agents-chat-meta">{w.meta}</span>}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="agents-context-foot">
        <Link to="/computer" className="agents-surface"><Monitor size={14} /> Computer</Link>
        <Link to="/browser" className="agents-surface"><Globe size={14} /> Browser</Link>
        <Link to="/terminal" className="agents-surface"><SquareTerminal size={14} /> Terminal</Link>
        <Link to="/files" className="agents-surface"><FolderOpen size={14} /> Files</Link>
      </div>
    </aside>
  );
}
