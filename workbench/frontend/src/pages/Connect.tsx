import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Brain, CalendarDays, Code2, Globe, Mail, Monitor, Plug, Puzzle, Sparkles, SquareTerminal,
} from "lucide-react";
import { api } from "../api";

type Status = {
  browser_enabled?: boolean;
  desk_enabled?: boolean;
  local_models_enabled?: boolean;
};

type Card = {
  id: string;
  category: string;
  title: string;
  blurb: string;
  to: string;
  icon: typeof Mail;
  ready?: (s: Status | null) => boolean | undefined;
};

const CARDS: Card[] = [
  { id: "models", category: "Thinking", title: "AI models", blurb: "Claude, ChatGPT, Gemini, or a model on this computer.", to: "/models", icon: Sparkles },
  { id: "skills", category: "Thinking", title: "Skills", blurb: "Saved ways of working. Add more whenever you like.", to: "/skills", icon: Puzzle },
  { id: "memory", category: "Thinking", title: "Memory", blurb: "What it already knows about you.", to: "/knowledge", icon: Brain },
  { id: "mail", category: "Apps", title: "Mail", blurb: "Gmail, Outlook, or Apple Mail.", to: "/settings", icon: Mail },
  { id: "calendar", category: "Apps", title: "Calendar", blurb: "See your day and make events.", to: "/calendar", icon: CalendarDays },
  { id: "code", category: "Tools", title: "Code agents", blurb: "Rooks, Claude Code, or Codex in a folder.", to: "/code", icon: Code2 },
  { id: "terminal", category: "Tools", title: "Terminal", blurb: "The same assistant in a terminal when you skip the window.", to: "/terminal", icon: SquareTerminal },
  { id: "computer", category: "Tools", title: "Computer", blurb: "Click and type on this machine when you allow it.", to: "/computer", icon: Monitor, ready: (s) => s?.desk_enabled },
  { id: "browser", category: "Tools", title: "Browser", blurb: "Open sites and do work in a browser for you.", to: "/browser", icon: Globe, ready: (s) => s?.browser_enabled },
  { id: "mcp", category: "Advanced", title: "Extra tools", blurb: "Outside tools you add yourself. Connect them when you need them.", to: "/mcp", icon: Plug },
];

const ORDER = ["Thinking", "Apps", "Tools", "Advanced"];

/** Connectors hub — categories like Cursor / Claude / ChatGPT. Skills and tools can be linked later. */
export default function Connect() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    api<Status>("/status").then(setStatus).catch(() => setStatus({}));
  }, []);

  return (
    <div className="connect-page">
      <header className="connect-hero">
        <p className="connect-kicker">Connect</p>
        <h1>What Rooks can use</h1>
        <p className="connect-lead">Pick a category. Connect what you need now; leave the rest for later. Nothing leaves this computer until you say yes.</p>
      </header>
      {ORDER.map((cat) => {
        const cards = CARDS.filter((c) => c.category === cat);
        if (!cards.length) return null;
        return (
          <section key={cat} className="connect-section" aria-label={cat}>
            <h2>{cat}</h2>
            <div className="connect-grid">
              {cards.map((c) => {
                const Icon = c.icon;
                const ready = c.ready?.(status);
                return (
                  <Link key={c.id} to={c.to} className="connect-card">
                    <span className="connect-icon" aria-hidden><Icon size={18} /></span>
                    <span className="grow">
                      <strong>{c.title}</strong>
                      <span className="small muted">{c.blurb}</span>
                    </span>
                    {ready === true && <span className="connect-pill on">On</span>}
                    {ready === false && <span className="connect-pill">Later</span>}
                    {ready === undefined && <span className="connect-pill">Open</span>}
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
