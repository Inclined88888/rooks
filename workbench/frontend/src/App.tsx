import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { CommandPalette } from "./Palette";
import { PRODUCT } from "./product";
import { RoomTerminalKeeper, TerminalKeeper } from "./terminalHost";
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
import { Loading, Page, ToastHost } from "./ui";
import { RooksMark } from "./ui/RooksMark";
import { pageComponent, warmWhenIdle } from "./pages/warm";
import { createKeyReader, SHORTCUTS } from "./lib/shortcuts";
import { setDevTools } from "./lib/devTools";
import { IS_MAC, MOD_KEY } from "./keys";
import { registerStageSurfaces } from "./stage/surfaces";
import { NeedsYouSheet } from "./needs/NeedsYou";
import { ShortcutsSheet, toggleShortcuts } from "./shell/ShortcutsSheet";
import { ShellChoiceBar } from "./shell/ShellChoiceBar";

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
  /** Settings, Advanced, "Show developer tools": off on a new install, kept by the install. */
  dev_tools?: boolean;
};

/** While Rooks Desk is driving the computer (from any page, chat or Rooks Code), a small still notice says so and offers Stop. */
function DeskNotice({ enabled }: { enabled: boolean }) {
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
  if (!job) return null;
  return createPortal(
    <div className="desk-notice" role="status">
      <span className="desk-notice-dot" aria-hidden="true" />
      <span>Rooks Desk is using your computer</span>
      <kbd className="ui-kbd">{IS_MAC ? "⌃⌥Esc" : "Ctrl+Alt+Esc"}</kbd>
      <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm"
        onClick={() => { api(`/desk/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => undefined); setJob(null); }}>Stop</button>
    </div>,
    document.body,
  );
}

function Boot() {
  return <div className="boot" role="status" aria-label="Loading"><div className="boot-brand"><RooksMark size={40} /><div className="wordmark lg">{PRODUCT}</div></div></div>;
}

// Sign in, the first welcome and the ask bar stay in the first load. Every registered page is its own chunk, warmed on
// hover and focus of any way to it (pages/warm.ts); a page whose chunk is here renders at once, else its frame shows
// at once with a Loading state (no blank screen, no full screen wordmark) until the chunk arrives.
function PageFrameLoading({ entry }: { entry: PageEntry }) {
  if (entry.rail === "chat" || entry.rail === "room") return <div className="page-frame-loading"><Loading rows={4} label={`Opening ${entry.label}`} /></div>;
  return <Page title={entry.label}><Loading rows={4} label={`Opening ${entry.label}`} /></Page>;
}

function PageElement({ entry, refresh }: { entry: PageEntry; refresh: () => void }) {
  const { C, ready } = useMemo(() => pageComponent(entry), [entry]);
  const props = typeof entry.props === "function" ? entry.props({ refresh }) : entry.props ?? {};
  if (ready) return <C {...props} />;
  return <Suspense fallback={<PageFrameLoading entry={entry} />}><C {...props} /></Suspense>;
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
        setDevTools(!!s.dev_tools);
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
  // Keyboard first (lib/shortcuts.ts is the one list): ⌘K/Ctrl+K the command menu, ? the shortcuts sheet, ⌘⇧O a new
  // chat, g then c/r/j/t/m/s a page. Letters and ? are never taken while typing in a field. The chat reads its own.
  useEffect(() => {
    const read = createKeyReader();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const s = read(e, Date.now());
      if (!s) return;
      if (s.id === "palette") { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      if (document.querySelector('[aria-modal="true"]') && s.id !== "new-chat") return; // a sheet or menu is open: it has the keys
      e.preventDefault();
      if (s.id === "shortcuts") toggleShortcuts();
      else if (s.id === "new-chat") { setPaletteOpen(false); navigate("/assistant", { state: { fresh: true } }); }
      else if (s.to) navigate(s.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const inShell = !!status?.signed_in && !!status.setup_complete;
  useEffect(() => (inShell ? warmWhenIdle(SHORTCUTS.flatMap((s) => (s.to ? [s.to] : []))) : undefined), [inShell]);

  const pages = useMemo(() => palettePages(status).map((p) => ({ to: p.path, label: p.label, icon: p.icon })), [status]);
  const openSearch = useCallback(() => setPaletteOpen(true), []);
  const openMore = useCallback(() => setMoreOpen((o) => !o), []); // the More button toggles its menu
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
    return <Welcome onDone={(work) => { refresh(); navigate(work.length ? `/coworkers?pick=${work.join(",")}` : "/assistant", { replace: true }); }} />;
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
        <ShellChoiceBar />
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
      <RoomTerminalKeeper />
      <DeskNotice enabled={!!status.desk_enabled} />
      <JobNotifier />{/* feat/v02-automations */}<DesktopBridge />{/* feat/tauri-native */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} pages={pages} />
      <AccountLayer />
      <NeedsYouSheet />
      <ShortcutsSheet />
      <ToastHost />
    </div>
  );
}
