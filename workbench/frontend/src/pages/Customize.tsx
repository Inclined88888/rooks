import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Brain, CalendarDays, Code2, Globe, Mail, Monitor, Plus, Puzzle, Sparkles, SquareTerminal, Wrench,
} from "lucide-react";
import { api } from "../api";

type Status = {
  browser_enabled?: boolean;
  desk_enabled?: boolean;
  local_models_enabled?: boolean;
};

type Tab = "apps" | "tools" | "skills" | "rules" | "agents";

type Row = {
  id: string;
  tab: Tab;
  title: string;
  blurb: string;
  to: string;
  icon: typeof Mail;
  ready?: (s: Status | null) => boolean | undefined;
  action?: string;
};

/** Cursor Customize clone: chip tabs + flat rows. Skills and tools connect later. */
const ROWS: Row[] = [
  { id: "mail", tab: "apps", title: "Mail", blurb: "Gmail, Outlook, or Apple Mail.", to: "/settings?section=apps", icon: Mail },
  { id: "calendar", tab: "apps", title: "Calendar", blurb: "See your day and make events.", to: "/calendar", icon: CalendarDays },
  { id: "models", tab: "tools", title: "AI models", blurb: "Claude, ChatGPT, Gemini, or a model on this computer.", to: "/models", icon: Sparkles, action: "Connect" },
  { id: "extra", tab: "tools", title: "Extra tools", blurb: "Outside tools you add yourself.", to: "/mcp", icon: Wrench, action: "Add" },
  { id: "computer", tab: "tools", title: "Computer", blurb: "Click and type on this machine when you allow it.", to: "/computer", icon: Monitor, ready: (s) => s?.desk_enabled },
  { id: "browser", tab: "tools", title: "Browser", blurb: "Open sites and do work in a browser for you.", to: "/browser", icon: Globe, ready: (s) => s?.browser_enabled },
  { id: "terminal", tab: "tools", title: "Terminal", blurb: "The same assistant when you skip the window.", to: "/terminal", icon: SquareTerminal },
  { id: "skills", tab: "skills", title: "Skill store", blurb: "Skills and connectors that match how you work. Copy more from a project if you want.", to: "/skills?tab=store", icon: Puzzle, action: "Open" },
  { id: "memory", tab: "rules", title: "Memory", blurb: "What it already knows about you.", to: "/knowledge", icon: Brain },
  { id: "about", tab: "rules", title: "About you", blurb: "Standing instructions that shape every reply.", to: "/about-you", icon: Brain },
  { id: "code", tab: "agents", title: "Code agents", blurb: "Rooks, Claude Code, or Codex in a folder.", to: "/code", icon: Code2 },
  { id: "chat", tab: "agents", title: "Chat agent", blurb: "Name, learning, search, and how it reaches you.", to: "/settings?section=agents", icon: Sparkles },
];

const TABS: { id: Tab; label: string }[] = [
  { id: "apps", label: "Apps" },
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "rules", label: "Rules" },
  { id: "agents", label: "Agents" },
];

export default function Customize() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "tools") as Tab;
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    api<Status>("/status").then(setStatus).catch(() => setStatus({}));
  }, []);

  const rows = ROWS.filter((r) => r.tab === tab);

  return (
    <div className="cursor-customize">
      <header className="cursor-customize-head">
        <div>
          <h1>Customize</h1>
          <p className="muted">Apps, tools, skills and rules in one place. Connect what you need; leave the rest for later.</p>
        </div>
        <Link className="btn" to="/settings"><Plus size={14} /> Open settings</Link>
      </header>

      <div className="cursor-chips" role="tablist" aria-label="Customize">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`cursor-chip${tab === t.id ? " on" : ""}`}
            onClick={() => setParams(t.id === "tools" ? {} : { tab: t.id }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="cursor-list" role="tabpanel">
        {rows.length === 0 && <p className="muted small" style={{ padding: 16 }}>Nothing here yet.</p>}
        {rows.map((r) => {
          const Icon = r.icon;
          const ready = r.ready?.(status);
          return (
            <Link key={r.id} to={r.to} className="cursor-row">
              <span className="cursor-row-icon" aria-hidden><Icon size={16} /></span>
              <span className="grow">
                <strong>{r.title}</strong>
                <span className="small muted">{r.blurb}</span>
              </span>
              {ready === true && <span className="cursor-status on">On</span>}
              {ready === false && <span className="cursor-status">Off</span>}
              {ready === undefined && <span className="btn sm ghost">{r.action || "Open"}</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
