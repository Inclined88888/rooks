import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { CommandPalette } from "./Palette";
import { PRODUCT } from "./product";
import { TerminalKeeper } from "./terminalHost";
import { EdgeGlow } from "./motion";
import Auth from "./pages/Auth";
import Welcome, { AccountsStep } from "./pages/Welcome";
import { AccountLayer } from "./ProGate";
import DesktopBridge from "./DesktopBridge"; // feat/tauri-native: aiworkspace:// links + tray
import JobNotifier from "./v02/JobNotifier"; // feat/v02-automations: desktop notifications for jobs
import AskBar from "./pages/AskBar";
import { PAGES, palettePages, REDIRECTS, type PageEntry } from "./pages/registry";
import { Rail } from "./shell/Rail";
import { PresenceStrip } from "./shell/PresenceStrip";
import { StageHost } from "./shell/StageHost";
import { MobileBar } from "./shell/MobileBar";
import { MoreSheet } from "./shell/MoreSheet";
import { ToastHost } from "./ui";
import { IS_MAC, MOD_KEY } from "./keys";
import { registerStageSurfaces } from "./stage/surfaces";
import { NeedsYouSheet } from "./needs/NeedsYou";

export { MOD_KEY };

// The Stage's surfaces (the Room, a browser job, a desk job, the terminal) draw themselves once registered.
registerStageSurfaces();

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
  return <EdgeGlow active={!!job} hotkey={IS_MAC ? "⌃⌥Esc" : "Ctrl+Alt+Esc"}
    onStop={job ? () => { api(`/desk/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => undefined); setJob(null); } : undefined} />;
}

function Boot() {
  return <div className="boot" role="status" aria-label="Loading"><div className="wordmark lg">{PRODUCT}</div></div>;
}

// Sign in, the first welcome and the ask bar stay in the first load. Every registered page loads when you open it.
const LAZY = new Map<PageEntry, ComponentType<Record<string, unknown>>>();
function lazyFor(entry: PageEntry): ComponentType<Record<string, unknown>> {
  let c = LAZY.get(entry);
  if (!c) { c = lazy(entry.load) as ComponentType<Record<string, unknown>>; LAZY.set(entry, c); }
  return c;
}

function PageElement({ entry, refresh }: { entry: PageEntry; refresh: () => void }) {
  const C = lazyFor(entry);
  const props = typeof entry.props === "function" ? entry.props({ refresh }) : entry.props ?? {};
  return <C {...props} />;
}

/** Every route and redirect, from the page registry. */
function AppRoutes({ refresh }: { refresh: () => void }) {
  return (
    <Routes>
      {REDIRECTS.map((r) => <Route key={`r-${r.from}`} path={r.from} element={<Navigate to={r.to} replace />} />)}
      {PAGES.flatMap((p) => [p.path, ...(p.also ?? [])].map((path) => (
        <Route key={path} path={path} element={<PageElement entry={p} refresh={refresh} />} />
      )))}
    </Routes>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    api<Status>("/status")
      .then((s) => {
        setStatus(s);
        setError("");
        // the product name, after the workspace's own name when it has one
        const own = (s.workspace_name || "").trim();
        document.title = own && own !== PRODUCT ? `${own} · ${PRODUCT}` : PRODUCT;
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
  useEffect(() => setMoreOpen(false), [location.pathname]);
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

  const pages = useMemo(() => palettePages(status).map((p) => ({ to: p.path, label: p.label, icon: p.icon })), [status]);
  const openSearch = useCallback(() => setPaletteOpen(true), []);
  const openMore = useCallback(() => setMoreOpen(true), []);
  const closeMore = useCallback(() => setMoreOpen(false), []);

  if (error) return <div className="auth"><div className="card auth-card col"><div className="alert err" role="alert">Cannot reach the app: {error}</div><button className="btn" onClick={refresh}>Try again</button></div></div>;
  if (!status) return <Boot />;
  if (!status.setup_complete || !status.signed_in) {
    if (status.desktop) {
      return <div className="auth"><div className="card auth-card"><div className="alert" role="status">Your session ended. Close and reopen {PRODUCT} to sign back in.</div></div></div>;
    }
    return <Auth status={status} onDone={refresh} />;
  }
  if (location.pathname === "/ask-bar") return <AskBar />; // feat/v02-anywhere-voice: the floating window, no shell
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

  const ownName = (status.workspace_name || "").trim();
  const shellName = !ownName || ownName === PRODUCT ? PRODUCT : ownName;
  const onChat = location.pathname === "/assistant" || location.pathname.startsWith("/assistant/");

  return (
    <div className="shell shell-agents">
      <a className="skip-link" href={onChat ? "#thread" : "#main"}>{onChat ? "Skip to the conversation" : "Skip to the page"}</a>
      <Rail status={status} name={shellName} onMore={openMore} onSearch={openSearch} />
      <div className="shell-main">
        <PresenceStrip />
        <main id="main" className="main agents-main" tabIndex={-1}>
          <StageHost renderRoutes={() => (
            <Suspense fallback={<Boot />}>
              <AppRoutes refresh={refresh} />
            </Suspense>
          )} />
        </main>
      </div>
      <MobileBar onMore={openMore} />
      <MoreSheet open={moreOpen} onClose={closeMore} status={status} name={shellName} onSearch={openSearch} />

      <TerminalKeeper />
      <DeskGlow enabled={!!status.desk_enabled} />
      <JobNotifier />{/* feat/v02-automations */}<DesktopBridge />{/* feat/tauri-native */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} pages={pages} />
      <AccountLayer />
      <NeedsYouSheet />
      <ToastHost />
    </div>
  );
}
