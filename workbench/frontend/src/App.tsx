import {
  Activity, Gauge, Bot, Brain, Building2, CalendarClock, CalendarDays, MessageSquare, CheckSquare, Globe, Columns3, ExternalLink, FileText, Home, Info, Mail, Menu, NotebookPen, Shield,
  Code2, FolderOpen, Globe2, GraduationCap, ListTree, Monitor, Palette as PaletteIcon, Plug, Sparkles, Puzzle, Search, Settings as SettingsIcon,
  Layers, // feat/v02-automations
  AudioLines, Users, // feat/v02-anywhere-voice
  UsersRound, // feat/team-lead
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "./Palette";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import AgentsSidebar from "./AgentsSidebar";
import AgentsContext from "./AgentsContext";
import { EdgeGlow, transitionClick } from "./motion";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import Welcome, { AccountsStep } from "./pages/Welcome";
import { AccountLayer } from "./ProGate";
import DesktopBridge from "./DesktopBridge"; // feat/tauri-native: aiworkspace:// links + tray
import JobNotifier from "./v02/JobNotifier"; // feat/v02-automations: desktop notifications for jobs
import AskBar from "./pages/AskBar";
import { FolderKanban, History as HistoryIcon } from "lucide-react"; // feat/v02-core
import { LineChart as LineChartIcon } from "lucide-react"; // phase 3: Insights
import { FileText as FileTextIcon, Lock as LockIcon, MessageCircle as MessageCircleIcon } from "lucide-react"; // feat/grok-style
import { FlaskConical, Mic, SquareTerminal, UserRound, Video } from "lucide-react"; // one icon per meaning in the nav
// Home, sign-in and the first welcome stay in the first load. Every other page loads when you open it.
const Assistant = lazy(() => import("./pages/Assistant"));
const Appearance = lazy(() => import("./pages/Appearance"));
const MotionLab = lazy(() => import("./pages/Motion"));
const Automations = lazy(() => import("./pages/Automations"));
const Company = lazy(() => import("./pages/Company"));
const Browser = lazy(() => import("./pages/Browser"));
const Code = lazy(() => import("./pages/Code"));
const Computer = lazy(() => import("./pages/Computer"));
const CalendarPage = lazy(() => import("./pages/Calendar"));
const Compare = lazy(() => import("./pages/Compare"));
const Docs = lazy(() => import("./pages/Docs"));
const FilesPage = lazy(() => import("./pages/Files"));
const SitesPage = lazy(() => import("./pages/Sites"));
const MailPage = lazy(() => import("./pages/Mail"));
const Research = lazy(() => import("./pages/Research"));
const Runs = lazy(() => import("./pages/Runs"));
const Insights = lazy(() => import("./pages/Insights"));
const FineTune = lazy(() => import("./pages/FineTune"));
const Status = lazy(() => import("./pages/Status"));
const Settings = lazy(() => import("./pages/Settings"));
const About = lazy(() => import("./pages/About"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Skills = lazy(() => import("./pages/Skills"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Models = lazy(() => import("./pages/Models"));
const AboutYou = lazy(() => import("./pages/AboutYou"));
const Teach = lazy(() => import("./pages/Teach"));
const Plan = lazy(() => import("./pages/Plan"));
const JobsPage = lazy(() => import("./v02/Jobs"));
const Meetings = lazy(() => import("./pages/Meetings"));
const Talk = lazy(() => import("./pages/Talk"));
const VoiceSettings = lazy(() => import("./pages/VoiceSettings"));
const Projects = lazy(() => import("./pages/Projects"));
const HistoryPage = lazy(() => import("./pages/History"));
const McpServers = lazy(() => import("./pages/McpServers"));
const Knowledge = lazy(() => import("./memory/Knowledge"));
const Team = lazy(() => import("./team/Team"));
const Teammates = lazy(() => import("./teammates/Teammates"));
const Groups = lazy(() => import("./teammates/Groups"));
const Vault = lazy(() => import("./teammates/Vault"));
const PagesLib = lazy(() => import("./teammates/Pages"));
const Channels = lazy(() => import("./teammates/Channels"));
const TerminalPage = lazy(() => import("./pages/TerminalPage"));
const Customize = lazy(() => import("./pages/Customize"));

export type Status = {
  setup_complete: boolean;
  signed_in: boolean;
  setup_code_required: boolean;
  workspace_name: string;
  chat_url: string;
  paperclip_url: string;
  hermes_url: string;
  browser_enabled: boolean;
  /** Rooks Desk (computer use) is running on this machine. */
  desk_enabled?: boolean;
  local_models_enabled: boolean;
  /** Running inside the native desktop app (desktop/), which signs the window in itself. */
  desktop?: boolean;
  welcome_done?: boolean;
  /** The Gmail / Apple / Microsoft / ChatGPT / Claude step has been shown. */
  signins_offered?: boolean;
  welcome_pending?: boolean;
  needs_models?: boolean;
};

type NavItem = { to: string; label: string; icon: typeof Home; addon?: "browser" | "desk" };
type NavGroup = { section?: string; collapsible?: boolean; items: NavItem[] };

/**
 * Cursor-shaped shell: Chat (+ Claude-style Code) on the rail.
 * Customize is Cursor's apps/tools/skills hub. Settings matches Cursor's left-nav settings.
 */
const NAV: NavGroup[] = [
  { items: [
    { to: "/assistant", label: "Chat", icon: MessageSquare },
    { to: "/code", label: "Code", icon: Code2 },
    { to: "/customize", label: "Customize", icon: Puzzle },
  ] },
  { section: "Workspace", collapsible: true, items: [
    { to: "/home", label: "Home", icon: Home },
    { to: "/mail", label: "Mail", icon: Mail },
    { to: "/calendar", label: "Calendar", icon: CalendarDays },
    { to: "/tasks", label: "Tasks", icon: CheckSquare },
    { to: "/notes", label: "Notes", icon: NotebookPen },
    { to: "/files", label: "Files", icon: FolderOpen },
    { to: "/automations", label: "Automations", icon: CalendarClock },
    { to: "/browser", label: "Browser", icon: Globe, addon: "browser" },
    { to: "/computer", label: "Computer", icon: Monitor, addon: "desk" },
    { to: "/terminal", label: "Terminal", icon: SquareTerminal },
    { to: "/teach", label: "Show me how", icon: GraduationCap },
    { to: "/knowledge", label: "Memory", icon: Brain },
    { to: "/skills", label: "Skills", icon: Puzzle },
    { to: "/team", label: "Team", icon: UsersRound },
    { to: "/research", label: "Research", icon: Search },
    { to: "/projects", label: "Projects", icon: FolderKanban },
    { to: "/meetings", label: "Meetings", icon: Video },
    { to: "/documents", label: "Documents", icon: FileText },
    { to: "/pages", label: "Pages", icon: FileTextIcon },
    { to: "/jobs", label: "Jobs", icon: Layers },
    { to: "/teammates", label: "Teammates", icon: Users },
    { to: "/channels", label: "Channels", icon: MessageCircleIcon },
    { to: "/talk", label: "Talk", icon: AudioLines },
    { to: "/vault", label: "Vault", icon: LockIcon },
    { to: "/sites", label: "Sites", icon: Globe2 },
  ] },
  { section: "Settings", collapsible: true, items: [
    { to: "/models", label: "AI models", icon: Gauge },
    { to: "/settings", label: "Settings", icon: SettingsIcon },
    { to: "/about-you", label: "About you", icon: UserRound },
    { to: "/voice", label: "Ask anywhere & voice", icon: Mic },
    { to: "/appearance", label: "Appearance", icon: PaletteIcon },
    { to: "/plan", label: "Your plan", icon: Sparkles },
    { to: "/about", label: "About", icon: Info },
    { to: "/privacy", label: "Privacy", icon: Shield },
  ] },
  { section: "Advanced", collapsible: true, items: [
    { to: "/history", label: "History", icon: HistoryIcon },
    { to: "/runs", label: "Run log", icon: ListTree },
    { to: "/insights", label: "Insights", icon: LineChartIcon },
    { to: "/compare", label: "Compare models", icon: Columns3 },
    { to: "/fine-tune", label: "Fine-tune", icon: FlaskConical },
    { to: "/company", label: "Company", icon: Building2 },
    { to: "/status", label: "System status", icon: Activity },
    { to: "/mcp", label: "Extra tools", icon: Plug },
  ] },
];

const RAIL: { to: string; label: string; icon: typeof MessageSquare; match?: (path: string) => boolean }[] = [
  { to: "/assistant", label: "Chat", icon: MessageSquare, match: (p) => p === "/assistant" || p.startsWith("/assistant/") },
  { to: "/code", label: "Code", icon: Code2, match: (p) => p === "/code" || p.startsWith("/code/") },
  { to: "/customize", label: "Customize", icon: Puzzle, match: (p) => p === "/customize" || p.startsWith("/customize") || p === "/connect" },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_KEY = isMac ? "⌘" : "Ctrl";

/** While Rooks Desk is driving the computer (from any page, chat or Rooks Code), the whole window's edge lights up. */
function DeskGlow({ enabled }: { enabled: boolean }) {
  const [job, setJob] = useState<{ id: string; goal: string } | null>(null);
  useEffect(() => {
    if (!enabled) return setJob(null);
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => api<{ id: string; goal: string; status: string }[]>("/desk/jobs")
      .then((js) => { if (!stop) setJob(js.find((j) => j.status === "running" || j.status === "queued" || j.status === "waiting") ?? null); })
      .catch(() => undefined)
      .finally(() => { if (!stop) t = setTimeout(tick, document.hidden ? 20000 : 10000); });
    t = setTimeout(tick, 4000);
    return () => { stop = true; clearTimeout(t); };
  }, [enabled]);
  return <EdgeGlow active={!!job} hotkey={isMac ? "⌃⌥Esc" : "Ctrl+Alt+Esc"}
    onStop={job ? () => { api(`/desk/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => undefined); setJob(null); } : undefined} />;
}

function Boot() {
  return <div className="boot" role="status" aria-label="Loading"><div className="wordmark lg">Rooks</div></div>;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    api<Status>("/status")
      .then((s) => {
        setStatus(s);
        setError("");
        // the product name on the sign-in screen and the desktop app, after the workspace's own name when it has one
        document.title = s.workspace_name && s.workspace_name !== "Rooks" ? `${s.workspace_name} · Rooks` : "Rooks";
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    const onUnauthorized = () => setStatus((s) => (s ? { ...s, signed_in: false } : s));
    window.addEventListener("wb:unauthorized", onUnauthorized);
    return () => window.removeEventListener("wb:unauthorized", onUnauthorized);
  }, []);
  // feat/v02-anywhere-voice: "Do it in Chat" from the ask bar (the desktop shell calls this in the main window)
  useEffect(() => {
    (window as unknown as { __wbHandoff?: (d: string) => void }).__wbHandoff = (draft) => navigate("/assistant", { state: { draft, at: Date.now() } });
  }, [navigate]);
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nav = useMemo(
    () => NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.addon || (i.addon === "browser" && status?.browser_enabled) || (i.addon === "desk" && status?.desk_enabled)) })),
    [status?.browser_enabled, status?.desk_enabled],
  );
  const palettePages = useMemo(
    () => [...nav.flatMap((g) => g.items.map((i) => ({ to: i.to, label: i.label, icon: i.icon })))],
    [nav],
  );

  if (error) return <div className="auth"><div className="card auth-card col"><div className="alert err" role="alert">Cannot reach Workbench: {error}</div><button className="btn" onClick={refresh}>Try again</button></div></div>;
  if (!status) return <Boot />;
  if (!status.setup_complete || !status.signed_in) {
    if (status.desktop) {
      return <div className="auth"><div className="card auth-card"><div className="alert" role="status">Your session ended. Close and reopen Rooks to sign back in.</div></div></div>;
    }
    return <Auth status={status} onDone={refresh} />;
  }
  if (location.pathname === "/ask-bar") return <AskBar />; // feat/v02-anywhere-voice: the floating window, no sidebar
  if (status.welcome_pending || ((status.desktop || status.needs_models) && !status.welcome_done)) {
    return <Welcome onDone={() => { refresh(); navigate("/assistant", { replace: true }); }} />;
  }
  if (!status.signins_offered) {
    return (
      <div className="auth">
        <div className="card auth-card welcome-card"><AccountsStep onNext={refresh} /></div>
      </div>
    );
  }

  return (
    <div className="shell shell-agents">
      <AgentsSidebar
        workspaceName={status.workspace_name}
        onSearch={() => setPaletteOpen(true)}
        onMore={() => setMenuOpen(true)}
      />

      {menuOpen && (
        <>
          <div className="modal-back rail-scrim" onClick={() => setMenuOpen(false)} />
          <aside className="more-drawer agents-more" aria-label="More pages">
            <div className="more-head">
              <strong className="truncate">{status.workspace_name}</strong>
              <button type="button" className="btn ghost sm" onClick={() => setPaletteOpen(true)}>
                <Search size={14} /> Search <span className="kbd">{MOD_KEY}K</span>
              </button>
            </div>
            <div className="more-scroll">
              {nav.filter((g) => g.section).map((g, gi) => {
                const items = g.items.filter((i) => !RAIL.some((r) => r.to === i.to));
                const extras = g.section === "Advanced" && (status.chat_url || status.paperclip_url || status.hermes_url);
                if (!items.length && !extras) return null;
                return (
                  <div key={g.section ?? gi} className="more-group">
                    <div className="more-section">{g.section}</div>
                    {items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className="more-link"
                        onClick={transitionClick(() => navigate(item.to))}
                      >
                        <item.icon size={16} />
                        <span className="truncate">{item.label}</span>
                      </NavLink>
                    ))}
                    {g.section === "Advanced" && (
                      <>
                        {status.chat_url && <a className="more-link" href={status.chat_url} target="_blank" rel="noreferrer"><MessageSquare size={16} /> Open WebUI <ExternalLink size={12} style={{ marginLeft: "auto" }} /></a>}
                        {status.paperclip_url && <a className="more-link" href={status.paperclip_url} target="_blank" rel="noreferrer"><Building2 size={16} /> Paperclip <ExternalLink size={12} style={{ marginLeft: "auto" }} /></a>}
                        {status.hermes_url && <a className="more-link" href={status.hermes_url} target="_blank" rel="noreferrer"><Bot size={16} /> Hermes agent <ExternalLink size={12} style={{ marginLeft: "auto" }} /></a>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>
        </>
      )}

      <main className="main agents-main">
        <div className="mobile-bar">
          <button className="btn ghost icon" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen}><Menu size={18} /></button>
          <strong className="truncate grow">{status.workspace_name}</strong>
          <button className="btn ghost icon" onClick={() => setPaletteOpen(true)} aria-label="Search or jump to"><Search size={17} /></button>
        </div>
        <div className="route">
        <Suspense fallback={<Boot />}>
        <Routes>
          <Route path="/" element={<Navigate to="/assistant" replace />} />
          <Route path="/home" element={<Dashboard />} />
          <Route path="/customize" element={<Customize />} />
          <Route path="/connect" element={<Navigate to="/customize" replace />} />
          <Route path="/assistant" element={<Assistant tab="chat" />} />
          <Route path="/assistant/:id" element={<Assistant tab="chat" />} />
          <Route path="/assistant-memory" element={<Assistant tab="memory" />} />
          <Route path="/assistant-skills" element={<Navigate to="/skills" replace />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/mcp" element={<McpServers />} />{/* feat/mcp-client */}
          <Route path="/about-you" element={<AboutYou />} />
          <Route path="/knowledge" element={<Knowledge />} />{/* feat/memory-core */}
          <Route path="/teach" element={<Teach />} />
          <Route path="/teach/:id" element={<Teach />} />
          <Route path="/packs" element={<Navigate to="/assistant" replace />} />
          <Route path="/packs/*" element={<Navigate to="/assistant" replace />} />
          <Route path="/appearance" element={<Appearance />} />
          <Route path="/appearance/motion" element={<MotionLab />} />
          <Route path="/models" element={<Models />} />
          <Route path="/assistant-settings" element={<Assistant tab="settings" />} />
          <Route path="/automations" element={<Automations />} />
          <Route path="/teammates" element={<Teammates />} />{/* feat/grok-style */}
          <Route path="/teammates/:id" element={<Teammates />} />{/* feat/grok-style */}
          <Route path="/groups/:id" element={<Groups />} />{/* feat/grok-style */}
          <Route path="/vault" element={<Vault />} />{/* feat/grok-style */}
          <Route path="/pages" element={<PagesLib />} />{/* feat/grok-style */}
          <Route path="/pages/:id" element={<PagesLib />} />{/* feat/grok-style */}
          <Route path="/channels" element={<Channels />} />{/* feat/grok-style */}
          <Route path="/jobs" element={<JobsPage />} />{/* feat/v02-automations */}
          <Route path="/company" element={<Company />} />
          <Route path="/research" element={<Research />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/research/:id" element={<Research />} />
          <Route path="/code" element={<Code />} />
          <Route path="/terminal" element={<TerminalPage />} />
          <Route path="/code/:id" element={<Code />} />
          <Route path="/browser" element={<Browser />} />
          <Route path="/browser/:id" element={<Browser />} />
          <Route path="/computer" element={<Computer />} />
          <Route path="/computer/:id" element={<Computer />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/projects" element={<Projects />} />{/* feat/v02-core */}
          <Route path="/projects/:id" element={<Projects />} />{/* feat/v02-core */}
          <Route path="/history" element={<HistoryPage />} />{/* feat/v02-core */}
          <Route path="/runs" element={<Runs />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/fine-tune" element={<FineTune />} />
          <Route path="/runs/:id" element={<Runs />} />
          <Route path="/status" element={<Status />} />
          <Route path="/notes" element={<Docs kind="note" />} />
          <Route path="/notes/:id" element={<Docs kind="note" />} />
          <Route path="/documents" element={<Docs kind="document" />} />
          <Route path="/documents/:id" element={<Docs kind="document" />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/team" element={<Team />} />{/* feat/team-lead */}
          <Route path="/team/people/:id" element={<Team />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/settings" element={<Settings onChanged={refresh} />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/plan" element={<Plan />} />
          {/* feat/v02-anywhere-voice */}
          <Route path="/talk" element={<Talk />} />
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/meetings/:id" element={<Meetings />} />
          <Route path="/voice" element={<VoiceSettings />} />
          <Route path="/welcome" element={<Navigate to="/assistant" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </div>
      </main>

      <AgentsContext
        workspaceName={status.workspace_name}
        browserEnabled={status.browser_enabled}
        deskEnabled={!!status.desk_enabled}
      />

      <DeskGlow enabled={!!status.desk_enabled} />
      <JobNotifier />{/* feat/v02-automations */}<DesktopBridge />{/* feat/tauri-native */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} pages={palettePages} />
      <AccountLayer />
    </div>
  );
}
