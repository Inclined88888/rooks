import { ChevronDown, Columns2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import {
  BESIDE_SCREENS,
  clampRatio,
  readStoredBeside,
  safePath,
  screenLabel,
  screenPath,
  suggestBeside,
  writeStoredBeside,
} from "./besideLogic.mjs";

type BesideState = { entry: string; ratio: number };

const storage = typeof localStorage === "undefined" ? null : localStorage;
const stored = readStoredBeside(storage);
let current: BesideState | null = stored ? { entry: stored.path, ratio: stored.ratio } : null;
let livePath = stored?.path ?? "";
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

function persist() {
  writeStoredBeside(storage, current ? { path: livePath || current.entry, ratio: current.ratio } : null);
}

function subscribeBeside(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function getBesideSnapshot() {
  return current;
}

/** Open a screen beside the one already showing. The page you are on stays put. */
export function openBeside(path: string) {
  if (!safePath(path)) return;
  livePath = path;
  current = { entry: path, ratio: current?.ratio ?? 0.5 };
  persist();
  notify();
}

export function closeBeside() {
  current = null;
  livePath = "";
  persist();
  notify();
}

function setBesideRatio(ratio: number) {
  if (!current) return;
  const next = clampRatio(ratio);
  if (next === current.ratio) return;
  current = { ...current, ratio: next };
  persist();
  notify();
}

function rememberLive(path: string) {
  if (!safePath(path.split("?")[0] || path)) return;
  livePath = path;
  if (current) persist();
}

function useBeside() {
  return useSyncExternalStore(subscribeBeside, getBesideSnapshot, () => null);
}

/** Small control on a chat, a shortcut, or a place: open it without leaving this page. */
export function BesideButton({ path, label, onOpen }: { path: string; label: string; onOpen?: () => void }) {
  return (
    <button
      type="button"
      className="agents-beside"
      title="Open beside"
      aria-label={`Open ${label} beside this`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openBeside(path);
        onOpen?.();
      }}
    >
      <Columns2 size={13} />
    </button>
  );
}

function PathWatch() {
  const loc = useLocation();
  useEffect(() => {
    rememberLive(`${loc.pathname}${loc.search}`);
  }, [loc.pathname, loc.search]);
  return null;
}

function RoutesHost({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

/**
 * Own React root for the second screen. React Router forbids a MemoryRouter under the
 * app BrowserRouter; a separate root keeps links on this side from stealing the URL and
 * keeps Terminal mounted when the main side changes.
 */
function BesideExtraHost({ entry, renderRoutes }: { entry: string; renderRoutes: () => ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Root | null>(null);
  const renderRef = useRef(renderRoutes);
  renderRef.current = renderRoutes;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // Own mount node so Strict Mode's deferred unmount cannot clear a newer root.
    const mount = document.createElement("div");
    mount.className = "beside-extra-mount";
    el.appendChild(mount);
    const root = createRoot(mount);
    rootRef.current = root;
    return () => {
      if (rootRef.current === root) rootRef.current = null;
      setTimeout(() => {
        root.unmount();
        mount.remove();
      }, 0);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.render(
      <MemoryRouter key={entry} initialEntries={[entry]}>
        <PathWatch />
        <div className="route">
          <RoutesHost render={() => renderRef.current()} />
        </div>
      </MemoryRouter>,
    );
  }, [entry]);

  return <div className="beside-extra-body" ref={hostRef} />;
}

/**
 * The main screen, plus a second one when you ask for it.
 * The second screen has its own place, so links inside it do not replace the first.
 */
export function BesideStage({ renderRoutes }: { renderRoutes: () => ReactNode }) {
  const beside = useBeside();
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const suggestion = suggestBeside(location.pathname);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = body.getBoundingClientRect();
      const stacked = window.matchMedia("(max-width: 900px)").matches;
      const ratio = stacked
        ? (ev.clientY - rect.top) / rect.height
        : (ev.clientX - rect.left) / rect.width;
      setBesideRatio(ratio);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const swap = () => {
    if (!beside) return;
    const here = `${location.pathname}${location.search}`;
    const there = livePath || beside.entry;
    navigate(there);
    openBeside(here);
  };

  const known = beside ? screenPath(beside.entry) : "";
  const stacked = typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;

  return (
    <div className="beside-stage">
      <div className="beside-bar" ref={menuRef}>
        <div className="beside-launch">
          <button
            type="button"
            className={`beside-open${beside ? " on" : ""}`}
            title={`Open ${screenLabel(suggestion)} beside this`}
            onClick={() => openBeside(suggestion)}
          >
            <Columns2 size={14} /> Side by side
          </button>
          <button
            type="button"
            className="beside-more"
            aria-label="Choose a screen"
            aria-expanded={menu}
            aria-haspopup="menu"
            onClick={() => setMenu((v) => !v)}
          >
            <ChevronDown size={14} />
          </button>
        </div>
        {menu && (
          <div className="beside-menu" role="menu" aria-label="Open beside this">
            {BESIDE_SCREENS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                className={s.path === suggestion ? "suggested" : ""}
                onClick={() => { openBeside(s.path); setMenu(false); }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={`beside-body${beside ? " is-split" : ""}`} ref={bodyRef}>
        <div className="beside-main" style={beside ? { flexGrow: beside.ratio, flexBasis: 0 } : undefined}>
          <div className="route">
            <RoutesHost render={renderRoutes} />
          </div>
        </div>
        {beside && (
          <>
            <div
              className="beside-grip"
              role="separator"
              aria-orientation={stacked ? "horizontal" : "vertical"}
              aria-label="Resize"
              onPointerDown={drag}
            />
            <section className="beside-extra" aria-label={screenLabel(beside.entry)} style={{ flexGrow: 1 - beside.ratio, flexBasis: 0 }}>
              <header className="beside-extra-bar">
                <label className="sr-only" htmlFor="beside-screen">Screen</label>
                <select
                  id="beside-screen"
                  className="beside-pick"
                  value={BESIDE_SCREENS.some((s) => s.path === known) ? known : beside.entry}
                  onChange={(e) => openBeside(e.target.value)}
                >
                  {!BESIDE_SCREENS.some((s) => s.path === known) && (
                    <option value={beside.entry}>{screenLabel(beside.entry)}</option>
                  )}
                  {BESIDE_SCREENS.map((s) => (
                    <option key={s.id} value={s.path}>{s.label}</option>
                  ))}
                </select>
                <span className="beside-extra-note">Keeps going while you use the other side.</span>
                <button type="button" className="btn ghost sm" onClick={swap}>Swap sides</button>
                <button type="button" className="btn ghost sm" onClick={closeBeside}>Close</button>
              </header>
              <BesideExtraHost entry={beside.entry} renderRoutes={renderRoutes} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
