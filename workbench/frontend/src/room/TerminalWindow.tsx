/**
 * The Room's Terminal window (docs/design/0006-room-desktop.md, section 3.1): a real login shell inside the Room that
 * lives on the service. Leaving the page keeps the shell, the panes stay mounted through the "room" keeper
 * (terminalHost.tsx), and a reload reattaches: the service replays the scrollback, so the same text is there.
 *
 * Two parts:
 *  - TerminalWindow, on the page (and the Stage): the title bar with New terminal, the tabs (names, order and state
 *    from the Room's status, never from the browser), the dark chrome bar with the phase words, the skip link, the
 *    slot the panes are drawn over, the ended row, and the phone key row; or the tail view on a phone that is not this
 *    computer; or the off state.
 *  - RoomPanes, in the keeper: one xterm pane per terminal (terminal/Shell.tsx) joined to
 *    /api/room/terminals/{id}/ws with replay.
 *
 * Every key in the terminal goes to the shell, Escape included; F6 is the one key the pane keeps, to leave it.
 */
import type { Terminal } from "@xterm/xterm";
import { Plus, Power, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { motionLevel } from "../motion";
import { Shell, type Phase } from "../terminal/Shell";
import { Button, EmptyState, Input, useToast } from "../ui";
import { leavesTerminal, phoneKey, pickActive, plainTail, toTermText, withCtrl, type PhoneKey } from "./desk";
import { focusWindowTitle, RoomWindow, type RoomActions } from "./RoomView";
import { refreshRoomStatus, useRoomStatusQuiet, type RoomState } from "./status";
import {
  focusTerminal, getTerms, markDone, markTaken, registerFocus, registerSender, sendRaw, setActiveTerminal, setCtrlLatch, setPaneWords, useTerms,
} from "./terms";
import {
  doneWords, elapsedWords, ENDED_SHORT, endedLine, fullLine, offLine, offStartLine, OPENING_LINE, PICKED_UP_LINE, ROOKS_STARTED_LINE, ROOKS_WORKING_LINE,
  STARTING_OVER_LINE, tailLine, terminalLabel, type RoomTerminal,
} from "./words";

const enc = encodeURIComponent;
const DONE_FOR_MS = 30000;

/** The close codes of a Room terminal's socket, in plain words. */
function roomWhy(code: number, reason: string): string {
  if (code === 4401) return "You are signed out. Sign in again, then come back to the Room.";
  if (code === 4403) return reason || "The terminal only opens on the computer running Rooks.";
  if (code === 4404) return "This terminal is gone. Open a new one.";
  if (code === 4409) return ENDED_SHORT;
  if (code === 1005 || code === 1006) return "The terminal lost its connection. Trying again…";
  if (!reason || /shell exited/i.test(reason)) return ENDED_SHORT;
  return reason;
}

/** Rooks's terminal takes no keys while Rooks works there, until the person takes it. */
function lockedFor(t: RoomTerminal, taken: Record<string, boolean>): boolean {
  return t.owner === "rooks" && t.alive && t.busy && !t.taken && !taken[t.id];
}

function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setCoarse(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return coarse;
}

/* ================================================================ the panes (drawn by the "room" keeper) */
export function RoomPanes({ parked }: { parked: boolean }) {
  const status = useRoomStatusQuiet();
  const ui = useTerms();
  const terminals = status.terminals;
  if (ui.remote || ui.switchedOff || !terminals.length) return null;
  const active = pickActive(terminals, ui.active);
  return (
    <div className="terminal-stage room-term-stage">
      {terminals.map((t) => <RoomPane key={t.id} t={t} active={t.id === active} hold={parked} locked={lockedFor(t, ui.taken)} />)}
    </div>
  );
}

function RoomPane({ t, active, hold, locked }: { t: RoomTerminal; active: boolean; hold: boolean; locked: boolean }) {
  // A terminal that was open when this pane was made joins its socket; one that had already ended shows its last lines.
  // The socket is chosen once: when the shell ends later, the text stays on screen, greyed, with the ended line.
  const [url] = useState(() => (t.alive ? `/api/room/terminals/${enc(t.id)}/ws` : null));
  const [initial, setInitial] = useState<string | null>(t.alive ? "" : null);
  const [gen, setGen] = useState(0);
  const [term, setTerm] = useState<Terminal | null>(null);
  const printed = useRef(false);
  const retries = useRef(0);
  const ended = !t.alive;
  const reason = useRef(t.ended_reason);
  reason.current = t.ended_reason;

  useEffect(() => {
    if (initial !== null) return;
    let stop = false;
    api<{ text?: string }>(`/room/terminals/${enc(t.id)}/tail?lines=200`)
      .then((r) => { if (!stop) setInitial(toTermText(r?.text || "")); })
      .catch(() => { if (!stop) setInitial(""); });
    return () => { stop = true; };
  }, [initial, t.id]);

  // Ended (the shell exited, Stop, Start over, a restart): the text stays and the line is printed once, in dim ink.
  useEffect(() => {
    if (!ended || !term || printed.current) return;
    printed.current = true;
    term.write(`\r\n\x1b[2m${endedLine(t.ended_reason)}\x1b[22m\r\n`);
    term.options.disableStdin = true;
    setPaneWords(t.id, { line: ENDED_SHORT, open: false });
  }, [ended, term, t.ended_reason, t.id]);

  useEffect(() => {
    if (term) term.options.disableStdin = locked || ended;
  }, [term, locked, ended]);

  const onTerm = useCallback((x: Terminal | null) => {
    setTerm(x);
    if (!x) { registerFocus(t.id, null); return; }
    x.attachCustomKeyEventHandler((e) => {
      if (leavesTerminal(e)) { e.preventDefault(); focusWindowTitle("terminal"); return false; }
      return true;
    });
    registerFocus(t.id, () => x.focus());
  }, [t.id]);
  useEffect(() => () => { registerSender(t.id, null); registerFocus(t.id, null); }, [t.id]);

  const onPhase = useCallback((phase: Phase, why: string, code: number) => {
    if (phase === "connecting") { setPaneWords(t.id, { line: OPENING_LINE, open: false }); return; }
    if (phase === "open") { retries.current = 0; setPaneWords(t.id, { line: "", open: true }); return; }
    if (code === 4403) { setPaneWords(t.id, { line: why, open: false, blocked: /switched off/i.test(why) ? "settings" : "remote" }); return; }
    if (code === 4409) {
      // it ended between the list and the socket: show its last lines, then say so
      void api<{ text?: string }>(`/room/terminals/${enc(t.id)}/tail?lines=200`).then((r) => term?.write(toTermText(r?.text || ""))).catch(() => undefined).finally(() => void refreshRoomStatus());
      setPaneWords(t.id, { line: ENDED_SHORT, open: false });
      return;
    }
    setPaneWords(t.id, { line: why, open: false });
    // a dropped connection (not an ended shell): ask again a few times; the service replays the text
    if ((code === 1005 || code === 1006) && retries.current < 3) {
      retries.current += 1;
      window.setTimeout(() => setGen((g) => g + 1), 2000);
    } else void refreshRoomStatus();
  }, [t.id, term]);

  const onReplay = useCallback((hadText: boolean) => {
    const age = Date.now() - Date.parse(t.started || "");
    if (!hadText || !(age > 5000)) return;
    setPaneWords(t.id, { line: PICKED_UP_LINE });
    window.setTimeout(() => { if (getTerms().words[t.id]?.line === PICKED_UP_LINE) setPaneWords(t.id, { line: "" }); }, 3000);
  }, [t.id, t.started]);

  const mapInput = useCallback((d: string) => {
    if (!getTerms().ctrl) return d;
    setCtrlLatch(false);
    return withCtrl(d);
  }, []);

  // The xterm options: 13 px mono, scrollback 5000 (Shell's defaults), read out to a screen reader, and no blinking
  // cursor when motion is off.
  const options = useMemo(() => ({ screenReaderMode: true, cursorBlink: motionLevel() !== "off" }), []);

  if (initial === null) return null;
  return (
    <div className={`room-term-pane${ended ? " is-ended" : ""}${active ? "" : " is-hidden"}`}>
      <Shell key={gen} url={url} replay active={active} hold={hold} label={t.name} options={options} connecting="" reopen={false}
        initialText={initial || undefined} why={roomWhy} onPhase={onPhase} onTerm={onTerm} onReplay={onReplay} mapInput={mapInput}
        onSend={(_run, raw) => registerSender(t.id, raw)} />
    </div>
  );
}

/* ================================================================ the window (on the page and the Stage) */
export function TerminalWindow({ status, act, slot, bare = false, stale = false }: {
  status: RoomState; act: RoomActions; slot: ReactNode; bare?: boolean; stale?: boolean;
}) {
  const toast = useToast();
  const ui = useTerms();
  const coarse = useCoarsePointer();
  const terminals = status.terminals;
  const activeId = pickActive(terminals, ui.active);
  const active = terminals.find((t) => t.id === activeId) ?? null;
  const full = terminals.length >= status.terminal_max;
  const newRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [closing, setClosing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [hinted, setHinted] = useState<Record<string, number>>({});

  // "Done (code 0)" on Rooks's tab for 30 s after its command ends.
  const wasBusy = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const t of terminals) {
      if (t.owner === "rooks" && wasBusy.current[t.id] && !t.busy && typeof t.exit_code === "number") markDone(t.id, Date.now());
      wasBusy.current[t.id] = t.busy;
    }
  }, [terminals]);
  const ticking = terminals.some((t) => (t.owner === "rooks" && t.busy) || now - (ui.doneAt[t.id] ?? 0) < DONE_FOR_MS);
  useEffect(() => {
    if (!ticking) return;
    const h = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(h);
  }, [ticking]);
  // "Rooks started this. You can type here too.", once, for a few seconds, when Rooks's idle terminal is first shown.
  useEffect(() => {
    if (!active || active.owner !== "rooks" || !active.alive || active.busy || hinted[active.id]) return;
    setHinted((h) => ({ ...h, [active.id]: Date.now() }));
    const h = window.setTimeout(() => setNow(Date.now()), 8000);
    return () => window.clearTimeout(h);
  }, [active, hinted]);

  const open = async () => {
    const r = await act.newTerminal();
    if (r?.id) window.setTimeout(() => focusTerminal(r.id || null), 300);
  };
  const close = async (t: RoomTerminal) => {
    const i = terminals.findIndex((x) => x.id === t.id);
    const next = terminals[i + 1] ?? terminals[i - 1] ?? null;
    setClosing(null);
    await act.closeTerminal(t.id, t.name);
    setActiveTerminal(next?.id ?? null);
    window.setTimeout(() => { if (next) tabRefs.current.get(next.id)?.focus(); else newRef.current?.focus(); }, 0);
  };
  const rename = (t: RoomTerminal, name: string) => {
    setRenaming(null);
    const clean = name.trim().slice(0, 40);
    if (clean && clean !== t.name) void act.renameTerminal(t.id, clean);
  };
  const take = async (t: RoomTerminal) => {
    const r = await act.takeTerminal(t.id);
    if (r) { markTaken(t.id); focusTerminal(t.id); }
  };
  const onTabKey = (e: ReactKeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step || !terminals.length) return;
    e.preventDefault();
    const next = terminals[(i + step + terminals.length) % terminals.length];
    setActiveTerminal(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const tabNote = (t: RoomTerminal): string => {
    if (t.owner === "rooks" && t.alive && t.busy && t.command) return elapsedWords(t.elapsed_s);
    if (t.owner === "rooks" && typeof t.exit_code === "number" && now - (ui.doneAt[t.id] ?? 0) < DONE_FOR_MS) return doneWords(t.exit_code);
    return "";
  };

  const tabs = terminals.length > 0 && (
    <>
      <div className="terminal-tabs room-tabs" role="tablist" aria-label="Terminals">
        {terminals.map((t, i) => {
          const on = t.id === activeId;
          const note = tabNote(t);
          return (
            <div key={t.id} className={`terminal-tab room-tab${on ? " is-active" : ""}${t.alive ? "" : " is-ended"}`}>
              {renaming === t.id ? (
                <input className="terminal-tab-rename" autoFocus aria-label="Terminal name" defaultValue={t.name} maxLength={40}
                  onBlur={(e) => rename(t, e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); rename(t, e.currentTarget.value); } if (e.key === "Escape") { e.preventDefault(); setRenaming(null); } }} />
              ) : (
                <button type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} className="terminal-tab-name room-tab-name"
                  ref={(el) => { if (el) tabRefs.current.set(t.id, el); else tabRefs.current.delete(t.id); }}
                  title={t.busy ? "running" : t.alive ? "Double-click to rename." : "This terminal ended."}
                  onClick={() => setActiveTerminal(t.id)} onDoubleClick={() => setRenaming(t.id)} onKeyDown={(e) => onTabKey(e, i)}>
                  {t.busy && <span className="room-tab-dot" aria-hidden="true" />}
                  {t.name}
                  {t.busy && <span className="sr-only">, running</span>}
                  {!t.alive && <span className="sr-only">, ended</span>}
                  {note && <span className="room-tab-note">{note}</span>}
                </button>
              )}
              <button type="button" className="terminal-tab-x room-tab-x" aria-label={`Close ${t.name}`} title="Close this terminal" onClick={() => setClosing(t.id)}><X size={12} /></button>
            </div>
          );
        })}
      </div>
      {closing && terminals.some((t) => t.id === closing) && (() => {
        const t = terminals.find((x) => x.id === closing)!;
        return (
          <div className="room-confirm" role="group" aria-label={`Close ${t.name}`}>
            <span className="room-confirm-line">{t.alive ? "Close this terminal? What it is running stops." : "Close this terminal? Its last lines go with it."}</span>
            <Button size="sm" variant="danger" busy={act.busy === `close:${t.id}`} autoFocus onClick={() => void close(t)}>Close</Button>
            <Button size="sm" variant="ghost" onClick={() => { setClosing(null); tabRefs.current.get(t.id)?.focus(); }}>Keep it</Button>
          </div>
        );
      })()}
    </>
  );

  const words = activeId ? ui.words[activeId] : undefined;
  const locked = !!active && lockedFor(active, ui.taken);
  const phaseLine = act.busy === "reset" ? STARTING_OVER_LINE
    : words?.line ? words.line
    : active && locked ? ROOKS_WORKING_LINE
    : active && active.owner === "rooks" && active.alive && !active.busy && now - (hinted[active.id] ?? 0) < 8000 ? ROOKS_STARTED_LINE
    : "";

  let body: ReactNode;
  if (ui.switchedOff) {
    body = <EmptyState icon={<SquareTerminal size={24} />} title="Terminals are switched off in Settings." line="Switch them on there to open a terminal in the Room."
      action={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/settings">Open Settings</Link>} />;
  } else if (!status.running) {
    body = (
      <>
        {tabs}
        <EmptyState icon={<SquareTerminal size={24} />} title={offLine(status)} line={offStartLine("terminal")}
          action={status.available && status.reachable ? <Button variant="primary" size="sm" icon={<Power size={13} />} busy={act.busy === "up"} onClick={() => void act.start()}>Start</Button> : undefined} />
      </>
    );
  } else if (!terminals.length) {
    body = <EmptyState icon={<SquareTerminal size={24} />} title="No terminal is open yet." line="Open one to type commands in the Room. It keeps running while you are in chat."
      action={<Button variant="primary" size="sm" icon={<Plus size={13} />} busy={act.busy === "terminal"} onClick={() => void open()}>Open a terminal</Button>} />;
  } else if (ui.remote) {
    body = <>{tabs}{active && <TailView key={active.id} t={active} locked={locked} taking={act.busy === `take:${active.id}`} onTake={() => void take(active)} />}</>;
  } else {
    body = (
      <>
        {tabs}
        <div className={`terminal-screen room-term${active && !active.alive ? " is-ended" : ""}`}>
          <div className="terminal-screen-bar room-term-bar">
            <span className="terminal-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="terminal-screen-title">{active?.name || "Terminal"}</span>
            <span className="room-term-status">
              <span role="status" aria-live="polite" className="room-term-words">{phaseLine}</span>
              {active && locked && <Button size="sm" variant="ghost" className="room-term-take" busy={act.busy === `take:${active.id}`} onClick={() => void take(active)}>Take this one</Button>}
            </span>
          </div>
          <button type="button" className="room-skip" onClick={() => { if (!focusWindowTitle("files")) document.getElementById("room-dock")?.focus(); }}>Skip the terminal</button>
          <div className="room-term-box" tabIndex={0} aria-label="The terminal. Press F6 to leave it." onFocus={(e) => { if (e.target === e.currentTarget) focusTerminal(activeId); }}>
            {slot}
          </div>
        </div>
        {active && !active.alive && (
          <div className="room-term-ended">
            <span className="room-term-ended-line">{endedLine(active.ended_reason)}</span>
            <Button size="sm" variant="secondary" icon={<Plus size={13} />} disabled={full} busy={act.busy === "terminal"} onClick={() => void open()}>Open a new terminal</Button>
            <Button size="sm" variant="ghost" busy={act.busy === `close:${active.id}`} onClick={() => void close(active)}>Close</Button>
          </div>
        )}
        {coarse && active?.alive && !locked && <KeyRow activeId={activeId} ctrl={ui.ctrl} />}
      </>
    );
  }

  const verbs = (
    <Button ref={newRef} size="sm" variant="secondary" icon={<Plus size={13} />} busy={act.busy === "terminal"}
      disabled={full || !status.running || ui.switchedOff}
      title={full ? fullLine(status.terminal_max) : !status.running ? "Start the Room first" : "Open another shell in the Room. The ones already open keep running."}
      onClick={() => void open().catch((e) => toast.err(e))}>New terminal</Button>
  );
  const label = ui.remote ? tailLine() : terminalLabel();

  if (bare) {
    return (
      <div className="room-term-bare">
        <div className="room-window-bar">
          <h2 id="room-terminal-title" className="room-window-title" tabIndex={-1} title="F6 leaves the terminal">Terminal</h2>
          <div className="room-window-verbs">{verbs}</div>
        </div>
        <div className="room-window-body">{body}</div>
      </div>
    );
  }
  return (
    <RoomWindow id="terminal" title="Terminal" titleTip="F6 leaves the terminal" verbs={verbs} label={label} stale={stale}>
      {body}
    </RoomWindow>
  );
}

/* ---------------------------------------------------------------- the phone's key row (touch only) */
const KEYS: { k: PhoneKey; label: string; name: string }[] = [
  { k: "Esc", label: "Esc", name: "Escape" }, { k: "Tab", label: "Tab", name: "Tab" },
];
const ARROWS: { k: PhoneKey; label: string; name: string }[] = [
  { k: "Up", label: "↑", name: "Up arrow" }, { k: "Down", label: "↓", name: "Down arrow" }, { k: "Left", label: "←", name: "Left arrow" }, { k: "Right", label: "→", name: "Right arrow" },
];

function KeyRow({ activeId, ctrl }: { activeId: string | null; ctrl: boolean }) {
  const press = (k: PhoneKey) => { sendRaw(activeId, phoneKey(k)); focusTerminal(activeId); };
  return (
    <div className="room-keys" role="group" aria-label="Keys a phone keyboard does not have">
      {KEYS.map((x) => <button key={x.k} type="button" className="room-key" aria-label={x.name} onClick={() => press(x.k)}>{x.label}</button>)}
      <button type="button" className="room-key" aria-pressed={ctrl} aria-label="Control: the next key is sent with Control"
        onClick={() => { setCtrlLatch(!ctrl); focusTerminal(activeId); }}>Ctrl</button>
      {ARROWS.map((x) => <button key={x.k} type="button" className="room-key" aria-label={x.name} onClick={() => press(x.k)}>{x.label}</button>)}
    </div>
  );
}

/* ---------------------------------------------------------------- the phone that is not this computer: the tail view */
type Tail = { text?: string; alive?: boolean; busy?: boolean; exit_code?: number | null; taken?: boolean };

/**
 * The full terminal opens only on the computer running Rooks. A phone sees the terminal's last lines (asked every
 * 2 s while the tab is visible, at once after a send) and types into the same shell through the send route.
 */
function TailView({ t, locked, taking, onTake }: { t: RoomTerminal; locked: boolean; taking: boolean; onTake: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [line, setLine] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<Tail>(`/room/terminals/${enc(t.id)}/tail?lines=200`);
      setText(plainTail(r?.text || ""));
    } catch {
      /* asked again in two seconds */
    } finally {
      setLoaded(true);
    }
  }, [t.id]);
  useEffect(() => {
    void load();
    const h = window.setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => window.clearInterval(h);
  }, [load]);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [text]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const cmd = line;
    if (!cmd.trim() || sending) return;
    setSending(true);
    try {
      await api(`/room/terminals/${enc(t.id)}/send`, { body: { text: cmd, enter: true } });
      setLine("");
      await load();
    } catch (err) {
      toast.err(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="room-tail-view">
      <pre ref={box} className={`room-tail${t.alive ? "" : " is-ended"}`} aria-label={`The last lines of ${t.name}`}>
        {loaded ? (text || "Nothing printed yet.") : "Asking for the last lines…"}
        {!t.alive && `\n${endedLine(t.ended_reason)}`}
      </pre>
      {t.alive && locked && (
        <p className="room-tail-take">
          <span>{ROOKS_WORKING_LINE}.</span>
          <Button size="sm" variant="ghost" busy={taking} onClick={onTake}>Take this one</Button>
        </p>
      )}
      {t.alive && (
        <form className="room-tail-row" onSubmit={(e) => void send(e)}>
          <Input className="room-tail-input" value={line} onChange={(e) => setLine(e.target.value)} aria-label="Command for this terminal"
            placeholder={locked ? "Rooks is working here" : "A command for this terminal"} disabled={locked}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" />
          <Button type="submit" variant="primary" busy={sending} disabled={!line.trim() || locked}>Send</Button>
        </form>
      )}
    </div>
  );
}

export default TerminalWindow;
