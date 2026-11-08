/**
 * The Room's Browser window (docs/design/0007-room-browser-and-native-app.md, sections 1.3 to 1.7): a real Chromium
 * inside the Room, on its desk after Terminal. Tabs, the address bar, back, forward, reload, the live page, mouse,
 * keyboard, wheel, copy and paste.
 *
 * Honesty rules in code: the page is shown only while the Room is on and has a browser here (browserOff says why not, in
 * plain words, never an empty frame); the live page joins /api/room/browser/ws, which the service opens only on the
 * computer running Rooks; elsewhere (a phone, a touch screen) a still from /room/browser/frame every 2 s with taps,
 * scroll buttons, an address field and a Type field (/room/browser/act), and the sentence that says what needs the
 * computer. Copy writes a ClipboardItem whose promise resolves with the page's selection; paste reads only the paste
 * event's text, so the Room never reads the clipboard otherwise. While Rooks acts the window says so; the person's own
 * click or key takes the browser back.
 */
import { ArrowLeft, ArrowRight, Globe, Plus, Power, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, fetchFrame } from "../api";
import { Button, EmptyState, IconButton, Input, useToast } from "../ui";
import {
  addressShown, BROWSER_LABEL, browserOff, clickCount, closedWords, copySelection, isCopy, keyMessage, keyStaysInApp, modifiers, NOT_LOCKED, OPENING,
  PHONE_LINE, ROOKS_USING, ROOKS_USING_LINE, stillMode, STILL_EVERY_MS, TABS_FULL, TAKEN_LINE, tabTitle, toViewPoint, type BrowserState,
  type BrowserTab, type Size,
} from "./browser";
import { isLoopbackHost } from "./desk";
import { focusWindowTitle, RoomWindow, type RoomActions } from "./RoomView";
import { refreshRoomStatus, type RoomState } from "./status";

const WS_PATH = "/api/room/browser/ws";
const MOVE_EVERY_MS = 33;

function useCoarse(): boolean {
  const q = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setCoarse(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return coarse;
}

export function BrowserWindow({ status, act, stale }: { status: RoomState; act: RoomActions; stale?: boolean }) {
  const coarse = useCoarse();
  const off = browserOff(status);
  const still = stillMode({ loopback: isLoopbackHost(location.hostname), coarse });
  let body: ReactNode;
  if (off) {
    const saved = status.browser.tabs;
    const action = off.reason === "off" && status.available && status.reachable
      ? <Button variant="primary" size="sm" icon={<Power size={13} />} busy={act.busy === "up"} onClick={() => void act.start()}>Start</Button>
      : off.reason === "switched_off" ? <Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/settings">Open Settings</Link>
      : off.reason === "no_engine" ? <Button variant="secondary" size="sm" onClick={() => void refreshRoomStatus()}>Check again</Button>
      : undefined;
    body = (
      <>
        <EmptyState icon={<Globe size={24} />} title={off.title} line={off.line} action={action} />
        {off.reason === "off" && saved.length > 0 && (
          <p className="room-browser-saved">Kept: {saved.map((t) => tabTitle(t)).join(", ")}</p>
        )}
      </>
    );
  } else body = still ? <StillBrowser /> : <LiveBrowser />;
  return (
    <RoomWindow id="browser" title="Browser" stale={stale} label={BROWSER_LABEL}>
      {body}
    </RoomWindow>
  );
}

/* ================================================================ the toolbar and tabs, shared by both views */
function Tabs({ state, onSwitch, onClose, onNew }: { state: BrowserState; onSwitch: (id: string) => void; onClose: (id: string) => void; onNew: () => void }) {
  const full = state.tabs.length >= (state.max ?? 8);
  return (
    <div className="room-browser-tabs">
      <div role="tablist" aria-label="Tabs" className="room-browser-tablist">
        {state.tabs.map((t: BrowserTab) => {
          const on = t.id === state.active;
          const title = tabTitle(t);
          return (
            <span key={t.id} className={`room-browser-tab${on ? " is-active" : ""}${t.asleep ? " is-asleep" : ""}`}>
              <button type="button" role="tab" aria-selected={on} className="room-browser-tab-face" title={t.asleep ? `${title} (asleep: it loads when opened)` : title}
                onClick={() => onSwitch(t.id)}>
                {t.loading && <span className="room-browser-spin" aria-hidden="true" />}
                <span className="room-browser-tab-name">{title}</span>
              </button>
              <button type="button" className="room-browser-tab-close" aria-label={`Close ${title}`} title="Close tab" onClick={() => onClose(t.id)}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        })}
      </div>
      <IconButton label="New tab" size="sm" disabled={full} title={full ? TABS_FULL : "New tab"} onClick={onNew}><Plus size={14} /></IconButton>
    </div>
  );
}

function Toolbar({ state, onNav, onGo }: { state: BrowserState; onNav: (action: "back" | "forward" | "reload" | "stop") => void; onGo: (address: string) => void }) {
  const active = state.tabs.find((t) => t.id === state.active);
  const shown = addressShown(active?.url);
  const [draft, setDraft] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = (draft ?? shown).trim();
    if (a) onGo(a);
    setDraft(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  return (
    <form className="room-browser-bar" onSubmit={submit}>
      <IconButton label="Back" size="sm" disabled={!state.back} onClick={() => onNav("back")}><ArrowLeft size={15} /></IconButton>
      <IconButton label="Forward" size="sm" disabled={!state.forward} onClick={() => onNav("forward")}><ArrowRight size={15} /></IconButton>
      {active?.loading
        ? <IconButton label="Stop loading" size="sm" onClick={() => onNav("stop")}><X size={15} /></IconButton>
        : <IconButton label="Reload" size="sm" onClick={() => onNav("reload")}><RotateCw size={14} /></IconButton>}
      <Input aria-label="Address" className="room-browser-address" placeholder="Type an address or a site" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        value={draft ?? shown} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); } }} />
    </form>
  );
}

function Lines({ state, line }: { state: BrowserState | null; line: string }) {
  const notes = state?.notes ?? [];
  const last = line || (state?.note ? state.note : "") || notes[notes.length - 1] || "";
  return (
    <>
      {state?.rooks && (
        <p className="room-browser-rooks" role="status"><span className="room-live-dot" aria-hidden="true" />{state.rooks_words || ROOKS_USING}. {ROOKS_USING_LINE}</p>
      )}
      {state?.taken && !state.rooks && <p className="room-browser-note" role="status">{TAKEN_LINE}</p>}
      <p className="room-browser-note" role="status" aria-live="polite">{last}{state && state.walled === false ? (last ? " · " : "") + NOT_LOCKED : ""}</p>
    </>
  );
}

/* ================================================================ the live page, on the computer running Rooks */
type Closed = { line: string; again: boolean } | null;

function LiveBrowser() {
  const toast = useToast();
  const [state, setState] = useState<BrowserState | null>(null);
  const [frame, setFrame] = useState("");
  const [view, setView] = useState<Size>({ width: 1280, height: 800 });
  const [closed, setClosed] = useState<Closed>(null);
  const [line, setLine] = useState("");
  const [gen, setGen] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const copyWait = useRef<((text: string) => void) | null>(null);
  const lastMove = useRef(0);
  const lastDown = useRef<{ t: number; x: number; y: number; n: number } | null>(null);

  const send = useCallback((m: object) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(m));
  }, []);

  // the socket: frames as binary (newest wins on the service), state as JSON
  useEffect(() => {
    setClosed(null);
    const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${WS_PATH}`);
    s.binaryType = "arraybuffer";
    ws.current = s;
    let shown = "";
    s.onopen = () => {
      const el = box.current;
      if (el) s.send(JSON.stringify({ type: "resize", width: Math.floor(el.clientWidth), height: Math.floor(el.clientHeight) }));
    };
    s.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        const url = URL.createObjectURL(new Blob([ev.data as ArrayBuffer], { type: "image/jpeg" }));
        const before = shown;
        shown = url;
        setFrame(url);
        if (before) window.setTimeout(() => URL.revokeObjectURL(before), 0);
        return;
      }
      let m: Record<string, unknown>;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "state") {
        const st = m as unknown as BrowserState;
        setState(st);
        if (Array.isArray(st.view)) setView({ width: st.view[0], height: st.view[1] });
      } else if (m.type === "view") setView({ width: Number(m.width) || 1280, height: Number(m.height) || 800 });
      else if (m.type === "note" || m.type === "error") setLine(String(m.text || ""));
      else if (m.type === "copy") { copyWait.current?.(String(m.text || "")); copyWait.current = null; }
    };
    s.onclose = (ev) => {
      ws.current = null;
      setClosed(closedWords(ev.code, ev.reason));
      void refreshRoomStatus();
    };
    return () => {
      s.onclose = null;
      s.close();
      ws.current = null;
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [gen]);

  // the page area follows the window's size
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => send({ type: "resize", width: Math.floor(el.clientWidth), height: Math.floor(el.clientHeight) }), 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); window.clearTimeout(t); };
  }, [send, closed]);

  // the wheel: not passive, so the app's page does not scroll instead
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const p = toViewPoint({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, view);
      const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? view.height : 1;
      send({ type: "wheel", x: p.x, y: p.y, dx: e.deltaX * scale, dy: e.deltaY * scale });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [send, view, frame]);

  const point = (e: { clientX: number; clientY: number }) => {
    const el = img.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return toViewPoint({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, view);
  };
  const button = (b: number) => (b === 2 ? "right" : b === 1 ? "middle" : "left");
  const onDown = (e: ReactPointerEvent<HTMLImageElement>) => {
    e.preventDefault();
    box.current?.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = point(e);
    const n = clickCount(lastDown.current, { t: e.timeStamp, x: p.x, y: p.y });
    lastDown.current = { t: e.timeStamp, x: p.x, y: p.y, n };
    send({ type: "mouse", event: "down", ...p, button: button(e.button), clicks: n, modifiers: modifiers(e) });
  };
  const onUp = (e: ReactPointerEvent<HTMLImageElement>) => {
    send({ type: "mouse", event: "up", ...point(e), button: button(e.button), clicks: lastDown.current?.n ?? 1, modifiers: modifiers(e) });
  };
  const onMove = (e: ReactPointerEvent<HTMLImageElement>) => {
    const now = performance.now();
    if (now - lastMove.current < MOVE_EVERY_MS) return;
    lastMove.current = now;
    send({ type: "mouse", event: "move", ...point(e), modifiers: modifiers(e) });
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (keyStaysInApp(e)) {
      if (e.key === "F6" && e.type === "keydown") { e.preventDefault(); focusWindowTitle("browser"); }
      return; // Ctrl or Cmd+V: the paste event brings the text
    }
    if (e.type === "keydown" && isCopy(e)) {
      e.preventDefault();
      const asked = new Promise<string>((resolve) => { copyWait.current = resolve; window.setTimeout(() => resolve(""), 3000); });
      send({ type: "copy" });
      const Item = (window as unknown as { ClipboardItem?: new (items: Record<string, Promise<Blob>>) => unknown }).ClipboardItem;
      void copySelection(navigator.clipboard as unknown as { write: (items: unknown[]) => Promise<void> }, Item, () => asked)
        .then((ok) => { if (!ok) toast.err(new Error("The copy did not reach your clipboard.")); });
      return;
    }
    e.preventDefault();
    send(keyMessage({ type: e.type, key: e.key, code: e.code, keyCode: e.keyCode, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }));
  };
  // paste: only the paste event's own text goes in (the Room never reads the clipboard otherwise)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const paste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain") || "";
      e.preventDefault();
      if (text) send({ type: "text", text });
    };
    el.addEventListener("paste", paste);
    return () => el.removeEventListener("paste", paste);
  }, [send, closed]);

  const active = state?.tabs.find((t) => t.id === state.active);
  if (closed) {
    return (
      <div className="room-browser-closed">
        <EmptyState icon={<Globe size={24} />} title={closed.line} line={state?.tabs.length ? "Its tabs and sign-ins are kept." : undefined}
          action={closed.again ? <Button variant="secondary" size="sm" onClick={() => setGen((g) => g + 1)}>Open again</Button> : undefined} />
      </div>
    );
  }
  return (
    <div className="room-browser">
      {state ? (
        <>
          <Tabs state={state} onSwitch={(id) => send({ type: "tab", action: "switch", id })} onClose={(id) => send({ type: "tab", action: "close", id })}
            onNew={() => send({ type: "tab", action: "new" })} />
          <Toolbar state={state} onNav={(action) => send({ type: "nav", action })} onGo={(address) => { setLine(""); send({ type: "nav", action: "go", address }); }} />
        </>
      ) : <p className="room-browser-note" role="status">{OPENING}</p>}
      <div ref={box} className="room-browser-view" tabIndex={0} aria-label="The page. Press F6 to leave it." onKeyDown={onKey} onKeyUp={onKey}>
        {frame
          ? <img ref={img} className="room-browser-frame" src={frame} alt={active ? `The page: ${tabTitle(active)}` : "The page"} draggable={false}
              style={{ width: view.width, height: view.height }}
              onPointerDown={onDown} onPointerUp={onUp} onPointerMove={onMove} onContextMenu={(e) => e.preventDefault()} />
          : <span className="room-browser-wait">{state ? "Waiting for the page…" : OPENING}</span>}
        {active?.blocked && <p className="room-browser-blocked" role="alert">{active.blocked}</p>}
      </div>
      <Lines state={state} line={line} />
    </div>
  );
}

/* ================================================================ a phone: a still, taps, scroll buttons, Type */
function StillBrowser() {
  const toast = useToast();
  const [state, setState] = useState<BrowserState | null>(null);
  const [src, setSrc] = useState("");
  const [text, setText] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState("");
  const img = useRef<HTMLImageElement>(null);
  const kick = useRef<() => void>(() => undefined);

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    let shown = "";
    const next = async () => {
      window.clearTimeout(timer);
      if (stop) return;
      if (!document.hidden) {
        try {
          let st = await api<BrowserState>("/room/browser");
          if (!st.open) { await api("/room/browser/start", { method: "POST" }); st = await api<BrowserState>("/room/browser"); }
          if (stop) return;
          setState(st);
          if (st.open && st.tabs.length) {
            const blob = await fetchFrame(`/room/browser/frame?k=${Date.now()}`);
            if (stop) return;
            const url = URL.createObjectURL(blob);
            const before = shown;
            shown = url;
            setSrc(url);
            if (before) window.setTimeout(() => URL.revokeObjectURL(before), 0);
          }
        } catch (e) {
          if (!stop) setLine(e instanceof Error ? e.message : "The Room's browser did not answer.");
          void refreshRoomStatus();
        }
      }
      if (!stop) timer = window.setTimeout(next, STILL_EVERY_MS);
    };
    kick.current = () => void next();
    void next();
    return () => { stop = true; window.clearTimeout(timer); if (shown) URL.revokeObjectURL(shown); };
  }, []);

  const actOn = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    try {
      const r = await api<{ ok?: boolean; note?: string }>("/room/browser/act", { body });
      setLine(r?.note || "");
      window.setTimeout(() => kick.current(), 400);
    } catch (e) {
      toast.err(e);
    } finally {
      setBusy("");
    }
  };
  const tap = (e: ReactPointerEvent<HTMLImageElement>) => {
    const el = img.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const view = { width: el.naturalWidth || 1280, height: el.naturalHeight || 800 };
    const p = toViewPoint({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, view);
    void actOn("tap", { kind: "click", x: p.x, y: p.y });
  };
  const active = state?.tabs.find((t) => t.id === state.active);
  return (
    <div className="room-browser is-still">
      {state && (
        <>
          <Tabs state={state} onSwitch={(id) => void actOn("tab", { kind: "tab", action: "switch", id })} onClose={(id) => void actOn("tab", { kind: "tab", action: "close", id })}
            onNew={() => void actOn("tab", { kind: "tab", action: "new" })} />
          <Toolbar state={state} onNav={(action) => void actOn("nav", { kind: "nav", action })} onGo={(address) => void actOn("nav", { kind: "nav", action: "go", address })} />
        </>
      )}
      <div className="room-browser-view is-still">
        {src
          ? <img ref={img} className="room-browser-frame is-still" src={src} alt={active ? `The page: ${tabTitle(active)}` : "The page"} draggable={false} onPointerUp={tap} />
          : <span className="room-browser-wait">{OPENING}</span>}
        {active?.blocked && <p className="room-browser-blocked" role="alert">{active.blocked}</p>}
      </div>
      <div className="room-browser-phone-row">
        <Button size="sm" variant="secondary" busy={busy === "up"} onClick={() => void actOn("up", { kind: "scroll", dy: -500 })}>Scroll up</Button>
        <Button size="sm" variant="secondary" busy={busy === "down"} onClick={() => void actOn("down", { kind: "scroll", dy: 500 })}>Scroll down</Button>
      </div>
      <form className="room-browser-phone-row" onSubmit={(e) => { e.preventDefault(); if (text) { void actOn("type", { kind: "type", text }); setText(""); } }}>
        <Input aria-label="Type into the page" placeholder="Tap a field, then type here" value={text} onChange={(e) => setText(e.target.value)} />
        <Button size="sm" type="submit" variant="secondary" busy={busy === "type"}>Type</Button>
        <Button size="sm" variant="ghost" busy={busy === "enter"} onClick={() => void actOn("enter", { kind: "key", key: "Enter" })}>Enter</Button>
      </form>
      <Lines state={state} line={line} />
      <p className="room-browser-phone-line">{PHONE_LINE}</p>
    </div>
  );
}
