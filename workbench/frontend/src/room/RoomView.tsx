/**
 * The Room's shared parts, used by the Room page (the desk) and the Stage (docs/design/0003-workroom.md, sections 3
 * and 4; docs/design/0006-room-desktop.md, sections 2 and 3): the actions with the words that follow them, the window
 * frame every desk window uses, the screen's picture with stepping in, the Commands window, and the small forms.
 *
 * Honesty rules in code: the picture (RoomPicture, the one picture element) is mounted only while roomScreenLive(status) says
 * the Room is running and has a real screen, and the screenshot route is asked only then; the mouse and keyboard
 * controls (Watch, Step in, Hand back) appear only when status.pointer is true. Where a Room terminal cannot exist, a
 * real Commands window runs commands through the Room's run route and says the honest line. Save a point and Start
 * over are reported done only when the service verified them; a hand-off is held in Needs you and nothing is copied
 * from here.
 */
import { Bookmark, Columns2, Eye, FileOutput, Hand, Laptop, Power, RotateCcw, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fetchFrame } from "../api";
import { openNeedsYou } from "../needs/store";
import { getPresence, refreshPresence, subscribePresence } from "../shell/presence";
import { openStage } from "../shell/StageHost";
import { Badge, Button, Card, EmptyState, IconButton, Input, Select, useToast } from "../ui";
import { errorText } from "../ui/toast";
import { addCommandLines, frameEvery, refreshRoomStatus, roomBusy, useRoomStatus, type CommandLine, type RoomState } from "./status";
import { setActiveTerminal } from "./terms";
import {
  commandViewLine, isolationWords, keyFor, NOT_HERE_LINE, offLine, offStartLine, pointLine, resetLine, roomScreenLive, RUN_TIMEOUT_S, STOPPED_LINE,
  TIMEOUT_NOTE, toScreenPoint, wheelSteps, type Checkpoint, type Point, type Size,
} from "./words";
import "./room.css";

export type Held = { ok?: boolean; held?: boolean; request_id?: string; needs_you_id?: string; summary?: string; note?: string; already_asked?: boolean };
type Panel = "point" | "reset" | "handoff" | null;
type Opened = { id?: string; name?: string; owner?: string; alive?: boolean };

/* ---------------------------------------------------------------- actions, with the words that follow them */
export function useRoomActions() {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  /** The last thing an action said, for the Room bar's live region. */
  const [said, setSaid] = useState("");
  const ok = (text: string) => { toast.ok(text); setSaid(text); };
  const run = async <T,>(what: string, call: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    try {
      return await call();
    } catch (e) {
      toast.err(e);
      return null;
    } finally {
      setBusy("");
      await refreshRoomStatus();
    }
  };
  /** The Room is said to be on only when the service answers running: true (honesty rule 6). */
  const start = () => run("up", async () => {
    const r = await api<{ running?: boolean; label?: string; error?: string }>("/room/up", { method: "POST" });
    if (r?.running) ok("The Room is on.");
    else toast.err(new Error(r?.error || "The Room did not start."));
    return r;
  });
  /** Stop hangs every Room terminal up first; the folder is kept, and Files still lists it. */
  const stop = () => run("down", async () => {
    const r = await api<{ running?: boolean; terminals_closed?: number }>("/room/down", { method: "POST" });
    if (r && !r.running) ok(STOPPED_LINE);
    return r;
  });
  /** Reported saved only once the service checked the point is really in the store (rule 4). */
  const savePoint = (label: string) => run("point", async () => {
    const r = await api<{ name?: string; verified?: boolean; removed?: string[] }>("/room/checkpoint", { body: { label } });
    if (r?.verified) ok(`Saved a point${label ? `: ${label}` : ""}.`);
    else toast.err(new Error("The point could not be confirmed, so it is not saved."));
    return r;
  });
  /** Terminals close first (the service does it); when the Room is on afterwards one new Terminal 1 opens. */
  const startOver = (name?: string) => run("reset", async () => {
    const r = await api<{ name?: string; verified?: boolean; terminals_closed?: number; terminal?: Opened | null }>("/room/reset", { body: name ? { name } : {} });
    if (r?.verified) {
      ok(`The Room is back at ${pointLine(r.name || name || "")}.`);
      if (r.terminal?.id) setActiveTerminal(r.terminal.id);
    } else toast.err(new Error("Starting over could not be confirmed. The Room was left as it was."));
    return r;
  });
  /** Nothing is copied here: the service holds the copy in Needs you (rule 5). */
  const handOff = (src: string, dest: string) => run("handoff", async () => {
    const r = await api<Held>("/room/handoff", { body: { src, dest } });
    void refreshPresence();
    if (r?.ok) ok("Copied out of the Room.");
    return r;
  });
  // ---- the Room's terminals (0006, section 6): the list comes back from status after each of these
  const newTerminal = () => run("terminal", async () => {
    const r = await api<Opened>("/room/terminals", { body: {} });
    if (r?.id) setActiveTerminal(r.id);
    return r;
  });
  const closeTerminal = (id: string, name: string) => run(`close:${id}`, async () => {
    const r = await api<{ ok?: boolean }>(`/room/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r?.ok !== false) setSaid(`${name} closed.`);
    return r;
  });
  const renameTerminal = (id: string, name: string) => run(`rename:${id}`, () => api<{ id?: string; name?: string }>(`/room/terminals/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }));
  const takeTerminal = (id: string) => run(`take:${id}`, async () => {
    const r = await api<{ taken?: boolean }>(`/room/terminals/${encodeURIComponent(id)}/take`, { body: { owner: "person" } });
    void refreshPresence();
    return r;
  });
  /** Close every terminal, the ended ones included (their records go too). */
  const closeAll = (ids: string[]) => run("close-all", async () => {
    let closed = 0;
    for (const id of ids) {
      await api(`/room/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
      closed += 1;
    }
    if (closed) ok(closed === 1 ? "1 terminal closed." : `${closed} terminals closed.`);
    return { closed };
  });
  return { busy, said, say: setSaid, start, stop, savePoint, startOver, handOff, newTerminal, closeTerminal, renameTerminal, takeTerminal, closeAll };
}

export type RoomActions = ReturnType<typeof useRoomActions>;

/* ---------------------------------------------------------------- a window on the desk */
/**
 * One window: the app's Card with a 36 px title bar (the name, the window's own verbs) and a label line. Windows are
 * never dragged or resized; the desk's grid places them. The title takes focus (F6 from the terminal, the skip link).
 */
export function RoomWindow({ id, title, titleTip, verbs, label, stale, children, className }: {
  id: string; title: string; titleTip?: string; verbs?: ReactNode; label?: ReactNode; stale?: boolean; children: ReactNode; className?: string;
}) {
  const titleId = `room-${id}-title`;
  return (
    <Card padding="none" as="section" aria-labelledby={titleId} className={["room-window", `room-window-${id}`, className].filter(Boolean).join(" ")}>
      <header className="room-window-bar">
        <h2 id={titleId} className="room-window-title" tabIndex={-1} title={titleTip}>{title}</h2>
        {verbs && <div className="room-window-verbs">{verbs}</div>}
      </header>
      {label && <p className="room-window-label">{label}</p>}
      {stale && <p className="room-window-label">Last known.</p>}
      <div className="room-window-body">{children}</div>
    </Card>
  );
}

/** Put focus on a window's title (after a verified Start over, from the skip link, from F6). */
export function focusWindowTitle(id: string): boolean {
  const el = document.getElementById(`room-${id}-title`);
  if (!el) return false;
  el.focus();
  return true;
}

/* ---------------------------------------------------------------- the screen: Watch, Step in, Hand back */
/**
 * The Screen window's parts: the picture (only while the Room really has a screen) or the off state, and the modes
 * (only when the Room takes a pointer). Shared by the Screen window on the desk and the Stage.
 */
export function useRoomScreen(status: RoomState, onStart: () => void, starting: boolean) {
  const [captured, setCaptured] = useState(false);
  const screenLive = roomScreenLive(status);
  const canStep = screenLive && status.pointer === true;
  useEffect(() => { if (!canStep) setCaptured(false); }, [canStep]);
  // Handing back puts focus on Step in: the Hand back button (or the picture) goes away under it, and focus is never
  // dropped to the page.
  const stepIn = useRef<HTMLButtonElement>(null);
  const release = useCallback(() => {
    setCaptured(false);
    window.setTimeout(() => stepIn.current?.focus(), 0);
  }, []);
  const modes = canStep ? (
    <span className="room-modes" role="group" aria-label="Your mouse and keyboard">
      <Button size="sm" variant="ghost" aria-pressed={!captured} icon={<Eye size={13} />} onClick={release}>Watch</Button>
      <Button ref={stepIn} size="sm" variant="ghost" aria-pressed={captured} icon={<Hand size={13} />} title="Step in to use your mouse and keyboard here" onClick={() => setCaptured(true)}>Step in</Button>
      {captured && <Button size="sm" variant="primary" icon={<Undo2 size={13} />} onClick={release}>Hand back</Button>}
    </span>
  ) : null;
  const picture = screenLive ? <RoomPicture captured={captured} onRelease={release} /> : (
    <EmptyState icon={<Laptop size={24} />} title={offLine(status)} line={offStartLine("screen")}
      action={status.available && status.reachable ? <Button variant="primary" size="sm" icon={<Power size={13} />} busy={starting} onClick={onStart}>Start</Button> : undefined} />
  );
  return { captured, setCaptured, release, modes, picture, screenLive };
}

/* ---------------------------------------------------------------- the Stage's frame */
export type RoomFrame = {
  status: RoomState; act: RoomActions; label: string; live: boolean; captured: boolean; controls: ReactNode;
  /** The screen's picture (or its off state), the goal line, the open form under the view. */
  picture: ReactNode; goal: ReactNode; panels: ReactNode;
  /** Open the hand off form with a file from the Files window filled in. */
  openHandoff: (src: string) => void;
};

/**
 * `pointsShown`: the Stage shows the Saved points window, which has its own Save a point and Start over from here, so
 * the frame's two step aside (one of each on screen, never two forms for the same thing).
 */
export function useRoomFrame({ mode, goal, onClose, pointsShown = false }: { mode: "page" | "stage"; goal?: string; onClose?: () => void; pointsShown?: boolean }): RoomFrame {
  const status = useRoomStatus();
  const act = useRoomActions();
  const navigate = useNavigate();
  const screen = useRoomScreen(status, () => void act.start(), act.busy === "up");
  const [panel, setPanel] = useState<Panel>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [handoffSrc, setHandoffSrc] = useState("");
  const points: Checkpoint[] = status.checkpoints ?? [];
  const toggle = (p: Panel) => { setHandoffSrc(""); setPanel((cur) => (cur === p ? null : p)); };

  const label = !status.checked ? "Checking the Room…"
    : !status.reachable ? "The Room could not be checked."
    : status.label || (status.available ? "Rooks's own computer" : NOT_HERE_LINE);

  const controls = (
    <>
      {status.available && status.reachable && (status.running
        ? <Button size="sm" icon={<Power size={13} />} busy={act.busy === "down"} onClick={() => void act.stop()}>Stop</Button>
        : <Button size="sm" variant="primary" icon={<Power size={13} />} busy={act.busy === "up"} onClick={() => void act.start()}>Start</Button>)}
      {screen.modes}
      {status.available && status.reachable && (
        <>
          {!pointsShown && (
            <>
              <Button size="sm" variant="ghost" icon={<Bookmark size={13} />} aria-pressed={panel === "point"} onClick={() => toggle("point")}>Save a point</Button>
              <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} aria-pressed={panel === "reset"} disabled={!points.length}
                title={points.length ? undefined : "Save a point first"} onClick={() => toggle("reset")}>Start over</Button>
            </>
          )}
          <Button size="sm" variant="ghost" icon={<FileOutput size={13} />} aria-pressed={panel === "handoff"} onClick={() => toggle("handoff")}>Hand off a file</Button>
        </>
      )}
      <span className="room-space" />
      {mode === "stage" && <Link className="ui-btn ui-btn-ghost ui-btn-sm" to="/room">Open the Room page</Link>}
      {mode === "page" && status.available && status.reachable && (
        <Button size="sm" variant="ghost" icon={<Columns2 size={13} />} title="Keep the Room on the Stage while you chat"
          onClick={() => { openStage({ surface: "room", jobId: "room" }); navigate("/assistant"); }}>Watch beside the chat</Button>
      )}
      {onClose && <IconButton label="Close the Stage" size="sm" onClick={onClose}><X size={15} /></IconButton>}
    </>
  );

  const panels = (
    <>
      {panel === "point" && !pointsShown && (
        <PointPanel busy={act.busy === "point"} onCancel={() => setPanel(null)}
          onSave={async (l) => { const r = await act.savePoint(l); if (r?.verified) setPanel(null); }} />
      )}
      {panel === "reset" && !pointsShown && (
        <ResetPanel closing={status.terminals.filter((t) => t.alive).length} points={points} initial={status.last_checkpoint?.name || undefined}
          busy={act.busy === "reset"} onCancel={() => setPanel(null)}
          onConfirm={async (n) => { const r = await act.startOver(n); if (r?.verified) { setPanel(null); screen.setCaptured(false); } }} />
      )}
      {panel === "handoff" && (
        <HandoffPanel initialSrc={handoffSrc} busy={act.busy === "handoff"} onCancel={() => setPanel(null)}
          onSend={async (s, d) => { const r = await act.handOff(s, d); if (r?.held) { setHeld(r); setPanel(null); } else if (r?.ok) setPanel(null); }} />
      )}
      {held && <HeldNote held={held} onClose={() => setHeld(null)} />}
    </>
  );

  const goalLine = goal ? <p className="room-goal"><span className="room-goal-k">Rooks is here to</span> {goal}</p> : null;
  const openHandoff = (src: string) => { setHandoffSrc(src); setPanel("handoff"); };
  return { status, act, label, live: status.running === true, captured: screen.captured, controls, picture: screen.picture, goal: goalLine, panels, openHandoff };
}

/** What the Room shows before it is known, when it did not answer, or when it is not installed; null when it is there. */
export function roomNotReady(status: RoomState): ReactNode {
  if (!status.checked) return <p className="room-line" role="status">Checking the Room…</p>;
  if (!status.reachable && !status.available) return <EmptyState icon={<Laptop size={24} />} title="The Room could not be checked." line="Rooks did not answer. It will be asked again in a moment." />;
  if (!status.available) return <EmptyState icon={<Laptop size={24} />} title={status.label || NOT_HERE_LINE} line={status.note || "Rooks gets its own computer inside this app. You will watch it work, step in, hand it back and undo what it did."} />;
  return null;
}

/* ---------------------------------------------------------------- the picture: only while the Room really has a screen */
function RoomPicture({ captured, onRelease }: { captured: boolean; onRelease: () => void }) {
  const toast = useToast();
  const [src, setSrc] = useState("");
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [stale, setStale] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const down = useRef<{ client: Point; screen: Point; button: number } | null>(null);
  const typed = useRef("");
  const typeTimer = useRef<number | undefined>(undefined);
  const lastWheel = useRef(0);

  // The next frame is fetched off screen and swapped in once it has loaded, so the screen never blinks: about one a
  // second while you have stepped in or a turn works in the Room, one every 3 s while you only watch, none while the tab
  // is hidden (frameEvery). A frame is never asked while the one before it is still loading. A frame that fails means
  // the Room changed: ask its status again. Frames are fetched with the same sign-in as every other call (a paired
  // browser has a token, not a cookie).
  const capturedRef = useRef(captured);
  capturedRef.current = captured;
  const kick = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    let shown = "";
    let loading = false;
    const later = (ms: number | null) => {
      window.clearTimeout(timer);
      timer = ms === null ? undefined : window.setTimeout(next, ms);
    };
    const cadence = () => frameEvery({ captured: capturedRef.current, busy: roomBusy(getPresence()), hidden: document.hidden });
    const failed = () => {
      loading = false;
      if (stop) return;
      setStale(true);
      void refreshRoomStatus();
      later(document.hidden ? null : 3000);
    };
    function next() {
      if (stop || loading) return; // the previous frame has not finished loading: skip this one
      if (document.hidden) { later(null); return; }
      loading = true;
      fetchFrame(`/room/screenshot?k=${Date.now()}`).then((blob) => {
        if (stop) { loading = false; return; }
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => {
          loading = false;
          if (stop) { URL.revokeObjectURL(url); return; }
          const before = shown;
          shown = url;
          setSrc(url);
          if (before) window.setTimeout(() => URL.revokeObjectURL(before), 0);
          setNatural((n) => (n.width === im.naturalWidth && n.height === im.naturalHeight ? n : { width: im.naturalWidth, height: im.naturalHeight }));
          setStale(false);
          later(cadence());
        };
        im.onerror = () => { URL.revokeObjectURL(url); failed(); };
        im.src = url;
      }, failed);
    }
    // Back on the tab, stepping in, or a turn starting in the Room: the next frame comes now, at the faster pace.
    kick.current = () => { if (!stop && !loading) { window.clearTimeout(timer); next(); } };
    const onVisible = () => { if (!document.hidden) kick.current(); };
    document.addEventListener("visibilitychange", onVisible);
    let wasBusy = roomBusy(getPresence());
    const unsub = subscribePresence(() => {
      const b = roomBusy(getPresence());
      if (b && !wasBusy) kick.current();
      wasBusy = b;
    });
    next();
    return () => {
      stop = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); unsub();
      if (shown) URL.revokeObjectURL(shown);
    };
  }, []);
  useEffect(() => { if (captured) kick.current(); }, [captured]);

  const send = useCallback((path: string, body: Record<string, unknown>) => {
    api<{ ok?: boolean; error?: string } | null>(path, { body })
      .then((r) => { if (r && r.ok === false && r.error) toast.err(new Error(r.error)); })
      .catch((e) => toast.err(e));
  }, [toast]);

  /** Where the pointer is on the Room's own screen, or null off the picture. */
  const at = useCallback((e: { clientX: number; clientY: number }): Point | null => {
    const el = img.current;
    if (!el) return null;
    return toScreenPoint({ x: e.clientX, y: e.clientY }, el.getBoundingClientRect(), natural);
  }, [natural]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!captured) return;
    e.preventDefault();
    wrap.current?.focus();
    const p = at(e);
    if (!p) return;
    down.current = { client: { x: e.clientX, y: e.clientY }, screen: p, button: e.button };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!captured || !down.current) return;
    const start = down.current;
    down.current = null;
    const end = at(e) ?? start.screen;
    const moved = Math.hypot(e.clientX - start.client.x, e.clientY - start.client.y) > 4;
    if (moved && start.button === 0) { send("/room/drag", { x1: start.screen.x, y1: start.screen.y, x2: end.x, y2: end.y }); return; }
    const button = start.button === 2 ? "right" : start.button === 1 ? "middle" : "left";
    send("/room/click", { x: start.screen.x, y: start.screen.y, button, count: 1 });
  };

  // The wheel needs a listener the browser may not treat as passive, or the page scrolls instead of the Room.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !captured) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel.current < 120) return;
      const p = at(e);
      const dy = wheelSteps(e.deltaY);
      if (!p || !dy) return;
      lastWheel.current = now;
      send("/room/scroll", { x: p.x, y: p.y, dy });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [captured, at, send]);

  // Keys go to the Room only while the picture itself has focus: typing into a form in the frame is never captured.
  const flushTyped = useCallback(() => {
    window.clearTimeout(typeTimer.current);
    const text = typed.current;
    typed.current = "";
    if (text) send("/room/type", { text });
  }, [send]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!captured) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); flushTyped(); onRelease(); return; }
    const k = keyFor(e);
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k.kind === "type") {
      typed.current += k.text;
      window.clearTimeout(typeTimer.current);
      typeTimer.current = window.setTimeout(flushTyped, 150);
    } else {
      flushTyped();
      send("/room/key", { keys: k.keys });
    }
  };
  useEffect(() => {
    if (captured) wrap.current?.focus();
    else flushTyped();
  }, [captured, flushTyped]);
  useEffect(() => () => window.clearTimeout(typeTimer.current), []);

  return (
    <div ref={wrap} className={`room-screen${captured ? " is-captured" : ""}`} tabIndex={captured ? 0 : -1}
      aria-label={captured ? "The Room's screen. Your mouse and keyboard go to it; press Escape to hand back." : "The Room's screen"}
      onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { down.current = null; }}
      onContextMenu={(e) => { if (captured) e.preventDefault(); }} onKeyDown={onKeyDown} onBlur={flushTyped}>
      {src
        ? <img ref={img} src={src} alt="What is on the Room's screen now" draggable={false} />
        : <p className="room-line" role="status">Waiting for the first frame…</p>}
      {stale && src && <span className="room-stale" role="status">Waiting for the next frame…</span>}
      {!captured && src && <span className="room-hint" aria-hidden="true">Step in to use your mouse and keyboard here</span>}
    </div>
  );
}

/* ---------------------------------------------------------------- the Commands window: a real shell, said honestly */
type RunResult = { ok?: boolean; code?: number; stdout?: string; stderr?: string; note?: string; error?: string; isolation?: string };

/**
 * Only where a Room terminal cannot exist (helper mode, Windows): one command at a time through the run route, up to two
 * minutes each. Its lines live in the status store, so leaving the page and coming back keeps them for the session.
 */
export function CommandView({ status }: { status: RoomState }) {
  const lines = status.commandLines;
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => { out.current?.scrollTo({ top: out.current.scrollHeight }); }, [lines]);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const command = cmd.trim();
    if (!command || busy || !status.running) return;
    setBusy(true);
    setCmd("");
    addCommandLines([{ kind: "cmd", text: command }]);
    try {
      const r = await api<RunResult>("/room/run", { body: { command, timeout: RUN_TIMEOUT_S } });
      const add: CommandLine[] = [];
      if (r.stdout) add.push({ kind: "out", text: r.stdout.replace(/\n$/, "") });
      if (r.stderr) add.push({ kind: "err", text: r.stderr.replace(/\n$/, "") });
      if (r.error && r.code !== 124) add.push({ kind: "err", text: r.error });
      if (r.code !== undefined && r.code !== 0) add.push({ kind: "note", text: r.code === 124 ? TIMEOUT_NOTE : `Finished with code ${r.code}.` });
      if (!add.length) add.push({ kind: "note", text: "Done, with nothing to show." });
      addCommandLines(add);
    } catch (err) {
      addCommandLines([{ kind: "err", text: errorText(err) }]);
    } finally {
      setBusy(false);
    }
  };

  const hint = status.running ? "Type a command below. Each command Rooks or you run here is in the run log." : `${offLine(status)} ${offStartLine("commands")}`;
  return (
    <div className="room-cmd">
      <pre ref={out} className="room-cmd-out" aria-live="polite" aria-label="Output">
        {lines.length
          ? lines.map((l, i) => <span key={i} className={`room-cmd-line is-${l.kind}`}>{l.kind === "cmd" ? `$ ${l.text}` : l.text}{"\n"}</span>)
          : <span className="room-cmd-hint">{hint}</span>}
      </pre>
      <form className="room-cmd-form" onSubmit={(e) => void run(e)}>
        <span className="room-cmd-prompt" aria-hidden="true">$</span>
        <Input className="room-cmd-input" value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label="Command to run in the Room"
          placeholder={status.running ? "A command to run in the Room" : "Start the Room first"} disabled={!status.running || busy}
          spellCheck={false} autoComplete="off" autoCapitalize="off" />
        <Button size="sm" type="submit" variant="primary" disabled={!status.running || !cmd.trim()} busy={busy}>Run</Button>
      </form>
    </div>
  );
}

/** The honest line with how separate the Room is (the Stage, the phone). Never hidden, never under Advanced. */
export function HonestLine({ status, className = "room-honest" }: { status: RoomState; className?: string }) {
  return (
    <p className={className}>
      <span>{commandViewLine(status)}</span>
      <Badge tone="neutral" title="How separate the Room is">{isolationWords(status.isolation, !!status.offline)}</Badge>
      {status.offline && <Badge tone="neutral">No network</Badge>}
    </p>
  );
}

/* ---------------------------------------------------------------- the three small forms */
export function PointPanel({ busy, onSave, onCancel }: { busy: boolean; onSave: (label: string) => void | Promise<void>; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  return (
    <form className="room-panel" onSubmit={(e) => { e.preventDefault(); void onSave(label.trim()); }}>
      <div className="room-panel-row">
        <Input label="Name this point" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Before the upgrade" autoFocus
          hint="The Room's files are copied as they are now, so you can start over from here later." />
        <Button type="submit" variant="primary" size="sm" busy={busy}>Save a point</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

/** `closing`: how many terminals are open; Start over closes them, and the form says how many, as the Points confirm does. */
export function ResetPanel({ points, initial, busy, closing = 0, onConfirm, onCancel }: {
  points: Checkpoint[]; initial?: string; busy: boolean; closing?: number; onConfirm: (name: string) => void | Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial && points.some((p) => p.name === initial) ? initial : points[0]?.name ?? "");
  return (
    <form className="room-panel" onSubmit={(e) => { e.preventDefault(); if (name) void onConfirm(name); }}>
      <p className="room-panel-line">{resetLine(closing)}</p>
      <div className="room-panel-row">
        <Select label="Start over from" value={name} onChange={(e) => setName(e.target.value)}>
          {points.map((p) => <option key={p.name} value={p.name}>{pointLine(p.name)}</option>)}
        </Select>
        <Button type="submit" variant="danger" size="sm" busy={busy} disabled={!name}>Start over</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Keep it as it is</Button>
      </div>
    </form>
  );
}

export function HandoffPanel({ busy, onSend, onCancel, initialSrc = "" }: {
  busy: boolean; onSend: (src: string, dest: string) => void | Promise<void>; onCancel: () => void; initialSrc?: string;
}) {
  const [src, setSrc] = useState(initialSrc);
  useEffect(() => { if (initialSrc) setSrc(initialSrc); }, [initialSrc]);
  const [dest, setDest] = useState("");
  const ready = !!src.trim() && !!dest.trim();
  return (
    <form className="room-panel" onSubmit={(e) => { e.preventDefault(); if (ready) void onSend(src.trim(), dest.trim()); }}>
      <p className="room-panel-line">A file leaves the Room only after your OK. Asking here puts the copy in Needs you; nothing is copied yet.</p>
      <div className="room-panel-row">
        <Input label="File in the Room" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="report.pdf" autoFocus />
        <Input label="Where to put it on this computer" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="~/Documents/report.pdf" />
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!ready}>Ask to hand it off</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

export function HeldNote({ held, onClose }: { held: Held; onClose: () => void }) {
  return (
    <div className="room-held" role="status">
      <Hand size={14} aria-hidden="true" />
      <span className="room-held-text"><b>Waiting for your OK.</b> {held.note || "Nothing was copied. It waits for your OK in Needs you."}</span>
      <Button size="sm" variant="primary" onClick={openNeedsYou}>Open Needs you</Button>
      <IconButton label="Dismiss" size="sm" onClick={onClose}><X size={14} /></IconButton>
    </div>
  );
}
