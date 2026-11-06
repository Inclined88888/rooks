/**
 * The Room's live view, shared by the Room page and the Stage (docs/design/0003-workroom.md, sections 3 and 4).
 * useRoomFrame() gives each of them the frame's label, its live and captured flags, the controls bar and the body.
 *
 * Honesty rules in code: the picture (RoomPicture, the one picture element) is mounted only while roomScreenLive(status) says
 * the Room is running and has a real screen, and the screenshot route is asked only then; the mouse and keyboard
 * controls (Watch, Step in, Hand back) appear only when status.pointer is true; otherwise a real command view runs
 * commands through the Room's run route and says the honest line. Save a point and Start over are reported done only
 * when the service verified them; a hand-off is held in Needs you and nothing is copied from here.
 */
import { Bookmark, Columns2, Eye, FileOutput, Hand, Laptop, Power, RotateCcw, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { openNeedsYou } from "../needs/store";
import { refreshPresence } from "../shell/presence";
import { openStage } from "../shell/StageHost";
import { Badge, Button, EmptyState, IconButton, Input, Select, useToast } from "../ui";
import { errorText } from "../ui/toast";
import { refreshRoomStatus, useRoomStatus, type RoomState } from "./status";
import {
  commandViewLine, isolationWords, keyFor, NOT_HERE_LINE, offLine, pointLine, roomScreenLive, RUN_TIMEOUT_S, toScreenPoint, wheelSteps,
  type Checkpoint, type Point, type Size,
} from "./words";
import "./room.css";

export type Held = { ok?: boolean; held?: boolean; request_id?: string; needs_you_id?: string; summary?: string; note?: string; already_asked?: boolean };
type Panel = "point" | "reset" | "handoff" | null;

/* ---------------------------------------------------------------- actions, with the words that follow them */
export function useRoomActions() {
  const toast = useToast();
  const [busy, setBusy] = useState("");
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
    if (r?.running) toast.ok("The Room is on.");
    else toast.err(new Error(r?.error || "The Room did not start."));
    return r;
  });
  const stop = () => run("down", async () => {
    const r = await api<{ running?: boolean }>("/room/down", { method: "POST" });
    if (r && !r.running) toast.ok("The Room is off.");
    return r;
  });
  /** Reported saved only once the service checked the point is really in the store (rule 4). */
  const savePoint = (label: string) => run("point", async () => {
    const r = await api<{ name?: string; verified?: boolean; removed?: string[] }>("/room/checkpoint", { body: { label } });
    if (r?.verified) toast.ok(`Saved a point${label ? `: ${label}` : ""}.`);
    else toast.err(new Error("The point could not be confirmed, so it is not saved."));
    return r;
  });
  const startOver = (name?: string) => run("reset", async () => {
    const r = await api<{ name?: string; verified?: boolean }>("/room/reset", { body: name ? { name } : {} });
    if (r?.verified) toast.ok(`The Room is back at ${pointLine(r.name || name || "")}.`);
    else toast.err(new Error("Starting over could not be confirmed. The Room was left as it was."));
    return r;
  });
  /** Nothing is copied here: the service holds the copy in Needs you (rule 5). */
  const handOff = (src: string, dest: string) => run("handoff", async () => {
    const r = await api<Held>("/room/handoff", { body: { src, dest } });
    void refreshPresence();
    if (r?.ok) toast.ok("Copied out of the Room.");
    return r;
  });
  return { busy, start, stop, savePoint, startOver, handOff };
}

/* ---------------------------------------------------------------- the frame's parts */
export type RoomFrame = { status: RoomState; label: string; live: boolean; captured: boolean; controls: ReactNode; body: ReactNode };

export function useRoomFrame({ mode, goal, onClose }: { mode: "page" | "stage"; goal?: string; onClose?: () => void }): RoomFrame {
  const status = useRoomStatus();
  const act = useRoomActions();
  const navigate = useNavigate();
  const [captured, setCaptured] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const screenLive = roomScreenLive(status);
  const canStep = screenLive && status.pointer === true;
  useEffect(() => { if (!canStep) setCaptured(false); }, [canStep]);
  const release = useCallback(() => setCaptured(false), []);
  const points: Checkpoint[] = status.checkpoints ?? [];
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  const label = !status.checked ? "Checking the Room…"
    : !status.reachable ? "The Room could not be checked."
    : status.label || (status.available ? "Rooks's own computer" : NOT_HERE_LINE);

  const controls = (
    <>
      {status.available && status.reachable && (status.running
        ? <Button size="sm" icon={<Power size={13} />} busy={act.busy === "down"} onClick={() => void act.stop()}>Stop</Button>
        : <Button size="sm" variant="primary" icon={<Power size={13} />} busy={act.busy === "up"} onClick={() => void act.start()}>Start</Button>)}
      {canStep && (
        <span className="room-modes" role="group" aria-label="Your mouse and keyboard">
          <Button size="sm" variant="ghost" aria-pressed={!captured} icon={<Eye size={13} />} onClick={release}>Watch</Button>
          <Button size="sm" variant="ghost" aria-pressed={captured} icon={<Hand size={13} />} onClick={() => setCaptured(true)}>Step in</Button>
          {captured && <Button size="sm" variant="primary" icon={<Undo2 size={13} />} onClick={release}>Hand back</Button>}
        </span>
      )}
      {status.available && status.reachable && (
        <>
          <Button size="sm" variant="ghost" icon={<Bookmark size={13} />} aria-pressed={panel === "point"} onClick={() => toggle("point")}>Save a point</Button>
          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} aria-pressed={panel === "reset"} disabled={!points.length}
            title={points.length ? undefined : "Save a point first"} onClick={() => toggle("reset")}>Start over</Button>
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

  let main: ReactNode;
  if (!status.checked) main = <p className="room-line" role="status">Checking the Room…</p>;
  else if (!status.reachable) main = <EmptyState icon={<Laptop size={24} />} title="The Room could not be checked." line="Rooks did not answer. It will be asked again in a moment." />;
  else if (!status.available) main = <EmptyState icon={<Laptop size={24} />} title={status.label || NOT_HERE_LINE} line={status.note || "Rooks gets its own computer inside this app. You will watch it work, step in, hand it back and undo what it did."} />;
  else main = screenLive ? <RoomPicture captured={captured} onRelease={release} /> : <CommandView status={status} />;

  const body = (
    <>
      {goal && <p className="room-goal"><span className="room-goal-k">Rooks is here to</span> {goal}</p>}
      {main}
      {panel === "point" && (
        <PointPanel busy={act.busy === "point"} onCancel={() => setPanel(null)}
          onSave={async (l) => { const r = await act.savePoint(l); if (r?.verified) setPanel(null); }} />
      )}
      {panel === "reset" && (
        <ResetPanel points={points} initial={status.last_checkpoint?.name || undefined} busy={act.busy === "reset"} onCancel={() => setPanel(null)}
          onConfirm={async (n) => { const r = await act.startOver(n); if (r?.verified) { setPanel(null); setCaptured(false); } }} />
      )}
      {panel === "handoff" && (
        <HandoffPanel busy={act.busy === "handoff"} onCancel={() => setPanel(null)}
          onSend={async (s, d) => { const r = await act.handOff(s, d); if (r?.held) { setHeld(r); setPanel(null); } else if (r?.ok) setPanel(null); }} />
      )}
      {held && <HeldNote held={held} onClose={() => setHeld(null)} />}
    </>
  );

  return { status, label, live: status.running === true, captured, controls, body };
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

  // The next frame is fetched off screen every second (every 5 s when the tab is hidden) and swapped in once it has
  // loaded, so the screen never blinks. A frame that fails means the Room changed: ask its status again.
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const next = () => {
      if (stop) return;
      const url = `/api/room/screenshot?k=${Date.now()}`;
      const im = new Image();
      im.onload = () => {
        if (stop) return;
        setSrc(url);
        setNatural((n) => (n.width === im.naturalWidth && n.height === im.naturalHeight ? n : { width: im.naturalWidth, height: im.naturalHeight }));
        setStale(false);
        timer = window.setTimeout(next, document.hidden ? 5000 : 1000);
      };
      im.onerror = () => {
        if (stop) return;
        setStale(true);
        void refreshRoomStatus();
        timer = window.setTimeout(next, 3000);
      };
      im.src = url;
    };
    next();
    return () => { stop = true; window.clearTimeout(timer); };
  }, []);

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

/* ---------------------------------------------------------------- the command view: a real shell, said honestly */
type Line = { kind: "cmd" | "out" | "err" | "note"; text: string };
type RunResult = { ok?: boolean; code?: number; stdout?: string; stderr?: string; note?: string; error?: string; isolation?: string };

function CommandView({ status }: { status: RoomState }) {
  const [lines, setLines] = useState<Line[]>([]);
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
    setLines((l) => [...l, { kind: "cmd", text: command }]);
    try {
      const r = await api<RunResult>("/room/run", { body: { command, timeout: RUN_TIMEOUT_S } });
      const add: Line[] = [];
      if (r.stdout) add.push({ kind: "out", text: r.stdout.replace(/\n$/, "") });
      if (r.stderr) add.push({ kind: "err", text: r.stderr.replace(/\n$/, "") });
      if (r.error) add.push({ kind: "err", text: r.error });
      if (r.code !== undefined && r.code !== 0) add.push({ kind: "note", text: r.code === 124 ? `Stopped after ${RUN_TIMEOUT_S} seconds.` : `Finished with code ${r.code}.` });
      if (!add.length) add.push({ kind: "note", text: "Done, with nothing to show." });
      setLines((l) => [...l, ...add]);
    } catch (err) {
      setLines((l) => [...l, { kind: "err", text: errorText(err) }]);
    } finally {
      setBusy(false);
    }
  };

  const hint = status.running ? "Type a command below. Everything run here is in the run log." : offLine(status);
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
      <p className="room-honest">
        <span>{commandViewLine(status)}</span>
        <Badge tone="neutral" title="How separate the Room is">{isolationWords(status.isolation)}</Badge>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- the three small forms */
function PointPanel({ busy, onSave, onCancel }: { busy: boolean; onSave: (label: string) => void | Promise<void>; onCancel: () => void }) {
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

function ResetPanel({ points, initial, busy, onConfirm, onCancel }: {
  points: Checkpoint[]; initial?: string; busy: boolean; onConfirm: (name: string) => void | Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial && points.some((p) => p.name === initial) ? initial : points[0]?.name ?? "");
  return (
    <form className="room-panel" onSubmit={(e) => { e.preventDefault(); if (name) void onConfirm(name); }}>
      <p className="room-panel-line">This puts the Room's files back as they were at that point. Anything done since is lost. The Room restarts if it is on.</p>
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

function HandoffPanel({ busy, onSend, onCancel }: { busy: boolean; onSend: (src: string, dest: string) => void | Promise<void>; onCancel: () => void }) {
  const [src, setSrc] = useState("");
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

function HeldNote({ held, onClose }: { held: Held; onClose: () => void }) {
  return (
    <div className="room-held" role="status">
      <Hand size={14} aria-hidden="true" />
      <span className="room-held-text"><b>Waiting for your OK.</b> {held.note || "Nothing was copied. It waits for your OK in Needs you."}</span>
      <Button size="sm" variant="primary" onClick={openNeedsYou}>Open Needs you</Button>
      <IconButton label="Dismiss" size="sm" onClick={onClose}><X size={14} /></IconButton>
    </div>
  );
}
