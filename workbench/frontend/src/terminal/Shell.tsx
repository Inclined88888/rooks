/**
 * One xterm.js pane joined to a shell over a WebSocket, shared by the app's Terminal page (/api/terminal/ws) and the
 * Room's terminals (/api/room/terminals/{id}/ws). Lifted out of pages/TerminalPage.tsx (docs/design/0006-room-desktop.md,
 * section 3.1) with two props added: `url`, the socket's path, and `replay`, for a shell that lives on the server. With
 * replay the server's first frame may be {"type":"scrollback","data":…}: the screen is reset and that text written once,
 * so coming back shows the same text. Everything else is written as it comes.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui";

export type Phase = "connecting" | "open" | "closed";

/** What a closed socket means, in plain words. The caller may give its own reading of the close codes. */
export type CloseWhy = (code: number, reason: string) => string;

export type ShellProps = {
  /** The socket's path on this host, e.g. "/api/terminal/ws". Null: no socket (an ended shell shown from its text). */
  url: string | null;
  /** The server keeps the shell and replays its scrollback as the first frame. */
  replay?: boolean;
  active: boolean;
  /** Parked off screen: do not fit or focus. */
  hold: boolean;
  label: string;
  /** Options laid over the defaults (13 px mono, scrollback 5000, the --screen colours). */
  options?: ITerminalOptions;
  /** The words while the socket opens. */
  connecting?: string;
  why: CloseWhy;
  /** Show "Reopen this terminal" when the socket closes (the app's terminal); the Room says what happened instead. */
  reopen?: boolean;
  /** Written once at mount, before any socket text (an ended shell's last lines). */
  initialText?: string;
  onPhase: (phase: Phase, why: string, code: number) => void;
  /** run(cmd) types a line and Enter; raw(data) sends keys as they are. */
  onSend: (run: (cmd: string) => void, raw: (data: string) => void) => void;
  /** The xterm itself, for a caller that keeps a key or prints a line (null when it goes). */
  onTerm?: (term: Terminal | null) => void;
  /** The server replayed text into a fresh screen (true when there was any). */
  onReplay?: (hadText: boolean) => void;
  /** Change what a key sends before it goes (the phone's Ctrl latch). */
  mapInput?: (data: string) => string;
};

export function Shell({ url, replay = false, active, hold, label, options, connecting = "Connecting…", why, reopen = true, initialText, onPhase, onSend, onTerm, onReplay, mapInput }: ShellProps) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [phase, setPhase] = useState<Phase>(url ? "connecting" : "closed");
  const [whyText, setWhyText] = useState("");
  const [code, setCode] = useState(0);
  const [gen, setGen] = useState(0);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const mapRef = useRef(mapInput);
  mapRef.current = mapInput;
  const cbs = useRef({ onSend, onTerm, onReplay, why });
  cbs.current = { onSend, onTerm, onReplay, why };

  useEffect(() => {
    if (!box.current) return;
    const css = getComputedStyle(document.documentElement);
    const tok = (name: string) => css.getPropertyValue(name).trim() || undefined;
    // The dark screen is on purpose; its colours are the --screen tokens in tokens.css. Blue, magenta and cyan are xterm's own.
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, screenReaderMode: true,
      fontFamily: tok("--font-mono") || "ui-monospace, Menlo, monospace",
      theme: {
        background: tok("--screen-bg"),
        foreground: tok("--screen-ink"),
        cursor: tok("--screen-ink"),
        cursorAccent: tok("--screen-bg"),
        selectionBackground: tok("--screen-border"),
        black: tok("--screen-bg"),
        red: tok("--screen-dot-close"),
        green: tok("--screen-dot-max"),
        yellow: tok("--screen-dot-min"),
        white: tok("--screen-ink"),
      },
      ...options,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    termRef.current = term;
    fitRef.current = fit;
    cbs.current.onTerm?.(term);
    if (!holdRef.current) {
      try { fit.fit(); } catch { /* hidden or not laid out yet */ }
    }
    if (initialText) term.write(initialText);
    let alive = true;
    const ro = new ResizeObserver(() => { if (holdRef.current) return; try { fit.fit(); } catch { /* hidden */ } });
    ro.observe(box.current);
    if (!url) {
      setPhase("closed");
      return () => {
        alive = false;
        ro.disconnect();
        cbs.current.onTerm?.(null);
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }
    setPhase("connecting");
    setWhyText("");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${url}`);
    const send = (m: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    const raw = (data: string) => send({ type: "input", data });
    const run = (cmd: string) => raw(cmd + "\r");
    cbs.current.onSend(run, raw);
    let first = true;
    ws.onopen = () => {
      if (!alive) return;
      setPhase("open");
      send({ type: "resize", cols: term.cols, rows: term.rows });
      if (active && !holdRef.current) term.focus();
    };
    ws.onmessage = (e) => {
      if (!alive) return;
      const text = typeof e.data === "string" ? e.data : "";
      if (replay && first) {
        first = false;
        if (text.startsWith("{")) {
          try {
            const frame = JSON.parse(text) as { type?: string; data?: string };
            if (frame && frame.type === "scrollback") {
              term.reset();
              const data = typeof frame.data === "string" ? frame.data : "";
              if (data) term.write(data);
              cbs.current.onReplay?.(!!data);
              return;
            }
          } catch { /* not a frame: it is output */ }
        }
      }
      term.write(text);
    };
    ws.onclose = (e) => {
      if (!alive) return;
      setPhase("closed");
      setCode(e.code);
      setWhyText(cbs.current.why(e.code, e.reason));
    };
    const input = term.onData((d) => raw(mapRef.current ? mapRef.current(d) : d));
    const resized = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    return () => {
      alive = false;
      ro.disconnect();
      input.dispose();
      resized.dispose();
      ws.close();
      cbs.current.onTerm?.(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [gen, url, replay]);

  const report = useRef(onPhase);
  report.current = onPhase;
  useEffect(() => { if (active) report.current(phase, whyText, code); }, [phase, whyText, code, active]);

  useEffect(() => {
    if (!active || hold) return;
    try { fitRef.current?.fit(); } catch { /* not open yet */ }
    termRef.current?.focus();
  }, [active, hold, phase]);

  return (
    <div className={`terminal-pane${active ? "" : " is-hidden"}`} aria-hidden={!active}>
      <div role="status" aria-live="polite" className="terminal-phase">{phase === "connecting" ? connecting : phase === "closed" && reopen ? whyText : ""}</div>
      <div ref={box} className="terminal-box" aria-label={label} />
      {phase === "closed" && reopen && url && (
        <div className="terminal-reopen"><Button size="sm" onClick={() => setGen((n) => n + 1)}>Reopen this terminal</Button></div>
      )}
    </div>
  );
}

export default Shell;
