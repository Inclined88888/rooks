import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  BookMarked, Boxes, CalendarDays, ChevronRight, Code2, Globe, Mail, MessageSquare, Monitor, Puzzle, Settings, SquareTerminal, UserRound, Wrench,
} from "lucide-react";
import { api } from "../api";
import { Badge, EmptyState, Page, Tabs } from "../ui";
import { ButtonLink } from "./settings/index";

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

/** Tabs and one list of rows: each opens the page where that thing is set up. */
const ROWS: Row[] = [
  { id: "mail", tab: "apps", title: "Mail", blurb: "Gmail, Outlook, or Apple Mail.", to: "/settings?section=apps", icon: Mail },
  { id: "calendar", tab: "apps", title: "Calendar", blurb: "See your day and make events.", to: "/calendar", icon: CalendarDays },
  { id: "models", tab: "tools", title: "AI models", blurb: "Claude, ChatGPT, Gemini, or a model on this computer.", to: "/models", icon: Boxes, action: "Connect" },
  { id: "extra", tab: "tools", title: "Extra tools", blurb: "Outside tools you add yourself.", to: "/extra-tools", icon: Wrench, action: "Add" },
  { id: "computer", tab: "tools", title: "Computer", blurb: "Click and type on this machine when you allow it.", to: "/computer", icon: Monitor, ready: (s) => s?.desk_enabled },
  { id: "browser", tab: "tools", title: "Browser", blurb: "Open sites and do work in a browser for you.", to: "/browser", icon: Globe, ready: (s) => s?.browser_enabled },
  { id: "terminal", tab: "tools", title: "Terminal", blurb: "The same assistant when you skip the window.", to: "/terminal", icon: SquareTerminal },
  { id: "skills", tab: "skills", title: "Skill store", blurb: "Skills and connectors that match how you work. Copy more from a project if you want.", to: "/skills?tab=store", icon: Puzzle, action: "Open" },
  { id: "memory", tab: "rules", title: "Memory", blurb: "What it already knows about you.", to: "/knowledge", icon: BookMarked },
  { id: "about", tab: "rules", title: "About you", blurb: "Standing instructions that shape every reply.", to: "/about-you", icon: UserRound },
  { id: "code", tab: "agents", title: "Code agents", blurb: "Rooks, Claude Code, or Codex in a folder.", to: "/code", icon: Code2 },
  { id: "chat", tab: "agents", title: "Chat agent", blurb: "Name, learning, search, and how it reaches you.", to: "/settings?section=agents", icon: MessageSquare },
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
    <Page title="Customize" description="Apps, tools, skills and rules in one place. Connect what you need; leave the rest for later." className="st-page"
      actions={<ButtonLink size="sm" to="/settings" icon={<Settings size={14} />}>Open settings</ButtonLink>}>
      <div className="st-tabs-row">
        <Tabs label="Customize" items={TABS} value={tab} onChange={(id) => setParams(id === "tools" ? {} : { tab: id }, { replace: true })} />
      </div>
      <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {rows.length === 0 ? <EmptyState title="Nothing here yet" line="Things you connect show up in this list." /> : (
          <div className="st-group">
            {rows.map((r) => {
              const Icon = r.icon;
              const ready = r.ready?.(status);
              return (
                <Link key={r.id} to={r.to} className="st-row-link">
                  <span className="st-row-icon" aria-hidden="true"><Icon size={16} /></span>
                  <span className="st-item-text">
                    <span className="st-row-label">{r.title}</span>
                    <span className="st-row-help">{r.blurb}</span>
                  </span>
                  {ready === true && <Badge tone="ok">On</Badge>}
                  {ready === false && <Badge>Off</Badge>}
                  {ready === undefined && r.action && <span className="st-small">{r.action}</span>}
                  <ChevronRight size={16} className="st-row-go" aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </Page>
  );
}
