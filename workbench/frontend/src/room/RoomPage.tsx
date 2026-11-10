/**
 * The Room page (/room): the Room as a small computer (docs/design/0006-room-desktop.md, section 2). A Room bar with
 * the state in words and the verbs (the one toolbar with verbs), a desk of plain windows (Terminal or Screen, Files,
 * Saved points) built from the Room's status, and a dock that only opens and closes windows, with the honest line at
 * its end. On a phone one window shows at a time, chosen with Tabs, and the honest line sits under them.
 *
 * Everything here is solid (the app's own chrome around the Room); the only dark surface is the terminal's own box.
 * Which windows exist comes from status (windowsFor); the browser remembers only which are open (desk.ts).
 */
import { Bookmark, ChevronDown, Columns2, FileOutput, Folder, Monitor, MoreHorizontal, Power, RotateCcw, SquareTerminal, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { narrowQuery, useMediaQuery } from "../shell/breakpoints";
import { openStage } from "../shell/StageHost";
import { TerminalSlot } from "../terminalHost";
import { Badge, Button, Menu, Sheet, Tabs, type ButtonProps, type MenuItem } from "../ui";
import { deskLayout, dockItems, pickActive, readDesk, terminalsCounted, terminalsFull, toggleWindow, windowsFor, writeDesk, type WindowId } from "./desk";
import { FilesWindow } from "./FilesWindow";
import { PointsWindow, type PointsAsk } from "./PointsWindow";
import {
  CommandView, HandoffPanel, HeldNote, roomNotReady, RoomWindow, useRoomActions, useRoomScreen, type Held,
} from "./RoomView";
import { useRoomStatus } from "./status";
import { TerminalWindow } from "./TerminalWindow";
import { setActiveTerminal, useTerms } from "./terms";
import { advancedDetails, commandsLabelFor, commandViewLine, isolationWords, pointLine, RECORDED_LINE, roomBarWord, terminalCountLine } from "./words";

const DOCK_ICON: Record<WindowId, LucideIcon> = { terminal: SquareTerminal, commands: SquareTerminal, files: Folder, points: Bookmark, screen: Monitor };

/** A verb in the Room bar: its icon and its word; under 1280 px the word is kept for the title and screen readers only. */
function Verb({ icon, word, ...rest }: { icon: ReactNode; word: string } & Omit<ButtonProps, "icon" | "children">) {
  return <Button size="sm" icon={icon} title={word} {...rest}><span className="room-verb-word">{word}</span></Button>;
}

export default function RoomPage() {
  const status = useRoomStatus();
  const act = useRoomActions();
  const ui = useTerms();
  const navigate = useNavigate();
  const location = useLocation();
  const narrow = useMediaQuery(narrowQuery);
  const offered = windowsFor(status);
  const offeredKey = offered.join(",");
  const [open, setOpen] = useState<WindowId[]>(() => readDesk(status));
  const [tab, setTab] = useState<WindowId | null>(null);
  const [handoff, setHandoff] = useState<{ src: string; n: number } | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [closingAll, setClosingAll] = useState(false);
  const [pointsAsk, setPointsAsk] = useState<PointsAsk>(null);
  const screen = useRoomScreen(status, () => void act.start(), act.busy === "up");
  const points = status.checkpoints ?? [];
  const available = status.available && status.reachable;
  const away = !status.reachable;

  // The windows status offers decide; a remembered window it does not offer is dropped, at render time.
  useEffect(() => { setOpen((cur) => { const kept = offered.filter((w) => cur.includes(w)); return kept.length ? kept : readDesk(status); }); }, [offeredKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = offered.filter((w) => open.includes(w));
  // The Room bar's live region says when a terminal ends ("Terminal 1 ended."), as status reports it.
  const wasAlive = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const t of status.terminals) {
      if (wasAlive.current[t.id] && !t.alive) act.say(`${t.name} ended.`);
      wasAlive.current[t.id] = t.alive;
    }
  }, [status.terminals]); // eslint-disable-line react-hooks/exhaustive-deps
  const phoneTab: WindowId | null = tab && offered.includes(tab) ? tab : offered[0] ?? null;

  const setDesk = (next: WindowId[]) => { setOpen(next); writeDesk(next); };
  const openWindow = (id: WindowId) => {
    const w = id === "terminal" && !offered.includes("terminal") ? "commands" : id;
    if (!offered.includes(w)) return;
    if (!open.includes(w)) setDesk([...open, w]);
    setTab(w);
  };
  const askPoints = (ask: Omit<NonNullable<PointsAsk>, "n">) => { openWindow("points"); setPointsAsk((p) => ({ ...ask, n: (p?.n ?? 0) + 1 })); };
  const openHandoff = (src = "") => setHandoff((h) => ({ src, n: (h?.n ?? 0) + 1 }));

  // The command menu's Room commands land here (Palette.tsx): open the window they name.
  useEffect(() => {
    const want = (location.state as { room?: string } | null)?.room;
    if (!want || !status.checked) return;
    if (want === "terminal") {
      openWindow("terminal");
      const alive = status.terminals.filter((t) => t.alive);
      if (status.running && status.can.terminal && !alive.length && !terminalsFull(status)) void act.newTerminal();
      else if (alive.length) setActiveTerminal(pickActive(alive, ui.active));
    } else if (want === "point") askPoints({ kind: "save" });
    else if (want === "over") openWindow("points");
    else if (want === "files") openWindow("files");
    navigate(location.pathname, { replace: true, state: null });
  }, [location.key, status.checked]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the Room bar
  const word = roomBarWord(status);
  const barLine = !status.checked ? "Checking the Room…"
    : !status.reachable ? "The Room could not be checked. Rooks did not answer; it will be asked again in a moment."
    : status.label || (status.available ? "Rooks's own computer" : "");
  const overItems: MenuItem[] = points.map((p) => ({ id: p.name, label: pointLine(p.name), onSelect: () => askPoints({ kind: "over", name: p.name }) }));
  const alive = status.terminals.filter((t) => t.alive);
  const advancedItems: MenuItem[] = [
    { id: "advanced", label: "Advanced", onSelect: () => setAdvanced(true) },
    { id: "close-all", label: "Close every terminal", danger: true, disabled: !status.terminals.length, onSelect: () => setClosingAll(true) },
  ];
  const phoneItems: MenuItem[] = available ? [
    status.running
      ? { id: "stop", label: "Stop", icon: <Power size={14} />, onSelect: () => void act.stop() }
      : { id: "start", label: "Start", icon: <Power size={14} />, onSelect: () => void act.start() },
    { id: "point", label: "Save a point", icon: <Bookmark size={14} />, onSelect: () => askPoints({ kind: "save" }) },
    { id: "over", label: "Start over", icon: <RotateCcw size={14} />, disabled: !points.length, hint: points.length ? undefined : "Save a point first",
      onSelect: () => { openWindow("points"); window.setTimeout(() => document.getElementById("room-points-title")?.focus(), 0); } },
    { id: "handoff", label: "Hand off a file", icon: <FileOutput size={14} />, onSelect: () => openHandoff() },
    ...advancedItems.slice(1),
    advancedItems[0],
  ] : [advancedItems[0]];

  const bar = (
    <div className="room-bar" role="toolbar" aria-label="The Room">
      <div className="room-bar-state" role="status" aria-live="polite">
        {status.running && <span className="room-live-dot" aria-hidden="true" />}
        {word && <span className="room-bar-word">{word}</span>}
        {word && barLine && <span className="room-bar-sep" aria-hidden="true">·</span>}
        <span className="room-bar-label">{barLine}</span>
        {act.said && <span className="sr-only">{act.said}</span>}
      </div>
      {narrow
        ? <Menu label="The Room's actions" items={phoneItems} className="room-bar-menu" />
        : (
          <div className="room-bar-verbs">
            {/* while Rooks does not answer, the verbs stay where they are, disabled */}
            {status.available && (status.running
              ? <Verb icon={<Power size={13} />} word="Stop" variant="secondary" disabled={away} busy={act.busy === "down"} onClick={() => void act.stop()} />
              : <Verb icon={<Power size={13} />} word="Start" variant="primary" disabled={away} busy={act.busy === "up"} onClick={() => void act.start()} />)}
            {status.available && <Verb icon={<Bookmark size={13} />} word="Save a point" variant="secondary" disabled={away} onClick={() => askPoints({ kind: "save" })} />}
            {status.available && (points.length && !away
              ? <Menu label="Start over" className="room-over" items={overItems}
                  icon={<span className="room-over-face"><RotateCcw size={13} aria-hidden="true" /><span className="room-verb-word">Start over</span><ChevronDown size={13} aria-hidden="true" /></span>} />
              : <Verb icon={<RotateCcw size={13} />} word="Start over" variant="secondary" disabled title={away ? "Start over" : "Save a point first"} />)}
            {status.available && <Verb icon={<FileOutput size={13} />} word="Hand off a file" variant="secondary" disabled={away} aria-pressed={!!handoff} onClick={() => (handoff ? setHandoff(null) : openHandoff())} />}
            {available && (
              <Verb icon={<Columns2 size={13} />} word="Watch beside the chat" variant="ghost" title="Keep the Room on the Stage while you chat"
                onClick={() => { openStage({ surface: "room", jobId: "room" }); navigate("/assistant"); }} />
            )}
            <Menu label="More for the Room" items={advancedItems} icon={<MoreHorizontal size={16} />} />
          </div>
        )}
    </div>
  );

  // ---- the panels under the bar: hand off a file (a sheet on phones), the held note, Close every terminal
  const handoffForm = handoff && (
    <HandoffPanel key={handoff.n} initialSrc={handoff.src} busy={act.busy === "handoff"} onCancel={() => setHandoff(null)}
      onSend={async (s, d) => { const r = await act.handOff(s, d); if (r?.held) { setHeld(r); setHandoff(null); window.setTimeout(() => document.querySelector<HTMLElement>(".room-held .ui-btn-primary")?.focus(), 0); } else if (r?.ok) setHandoff(null); }} />
  );
  const panels = (
    <>
      {!narrow && handoffForm}
      {narrow && <Sheet open={!!handoff} onClose={() => setHandoff(null)} title="Hand off a file">{handoffForm}</Sheet>}
      {held && <HeldNote held={held} onClose={() => setHeld(null)} />}
      {closingAll && (
        <div className="room-panel room-confirm" role="group" aria-label="Close every terminal">
          <span className="room-confirm-line">Close every terminal? What they are running stops. {status.terminals.length === 1 ? "1 terminal" : `${status.terminals.length} terminals`} in all.</span>
          <Button size="sm" variant="danger" busy={act.busy === "close-all"} autoFocus
            onClick={async () => { await act.closeAll(status.terminals.map((t) => t.id)); setClosingAll(false); }}>Close them</Button>
          <Button size="sm" variant="ghost" onClick={() => setClosingAll(false)}>Keep them</Button>
        </div>
      )}
    </>
  );

  // ---- the windows
  const stale = !status.reachable;
  const terminal = (() => { const id = pickActive(status.terminals, ui.active); return status.terminals.find((t) => t.id === id && t.alive) ?? null; })();
  const windowFor = (id: WindowId): ReactNode => {
    switch (id) {
      case "screen":
        return (
          <RoomWindow key="screen" id="screen" title="Screen" verbs={screen.modes} stale={stale} className={screen.captured ? "is-captured" : undefined}
            label={[status.label, status.note].filter(Boolean).join(" ")}>
            {screen.picture}
          </RoomWindow>
        );
      case "terminal":
        return <TerminalWindow key="terminal" status={status} act={act} stale={stale} slot={<TerminalSlot kind="room" />} />;
      case "commands":
        return <RoomWindow key="commands" id="commands" title="Commands" label={commandsLabelFor(status)} stale={stale}><CommandView status={status} /></RoomWindow>;
      case "files":
        return <FilesWindow key="files" status={status} terminal={terminal} stale={stale} onHandOff={(src) => openHandoff(src)} />;
      case "points":
        return <PointsWindow key="points" status={status} act={act} ask={pointsAsk} stale={stale} />;
    }
  };

  const honest = (
    <p className="room-dock-honest">
      <span className="room-dock-line">{commandViewLine(status)}</span>
      <Badge tone="neutral" title="How separate the Room is">{isolationWords(status.isolation, !!status.offline)}</Badge>
      {status.offline && <Badge tone="neutral">No network</Badge>}
    </p>
  );

  const notReady = roomNotReady(status);
  let desk: ReactNode;
  if (notReady) desk = <div className="room-desk is-single">{notReady}</div>;
  else if (narrow) desk = <div className="room-desk is-phone">{phoneTab && windowFor(phoneTab)}</div>;
  else {
    const { primary, side } = deskLayout(shown);
    const shape = !primary ? "is-side-only" : !side.length ? "is-primary-only" : "is-split";
    desk = (
      <div className={`room-desk ${shape}`}>
        {primary && <div className="room-desk-main">{windowFor(primary)}</div>}
        {side.length > 0 && <div className="room-desk-side">{side.map((w) => windowFor(w))}</div>}
      </div>
    );
  }

  const items = dockItems(status);
  const dock = notReady ? null : narrow
    ? (
      <div className="room-dock is-phone" id="room-dock" tabIndex={-1}>
        <Tabs label="Windows" items={offered.map((w) => ({ id: w, label: items.find((d) => d.id === w)?.label ?? w }))} value={phoneTab ?? ""} onChange={(id) => setTab(id as WindowId)} />
        {honest}
      </div>
    )
    : (
      <div className="room-dock" role="toolbar" aria-label="Windows" id="room-dock" tabIndex={-1}>
        <div className="room-dock-items">
          {items.map((d) => {
            const on = shown.includes(d.id);
            const last = on && shown.length === 1;
            const Icon = DOCK_ICON[d.id];
            return (
              <span key={d.id} className="room-dock-item">
                <Button variant="ghost" icon={<Icon size={16} />} aria-pressed={on} disabled={last}
                  title={last ? "One window stays open" : on ? `Close ${d.label}` : `Open ${d.label}`}
                  onClick={() => setDesk(toggleWindow(shown, d.id))}>{d.label}</Button>
              </span>
            );
          })}
        </div>
        {honest}
      </div>
    );

  const { kind, folder } = advancedDetails(status);
  const shellPath = status.terminals.find((t) => t.shell)?.shell || "";
  return (
    <div className="room-page">
      <h1 className="sr-only">The Room</h1>
      {bar}
      {panels}
      {desk}
      {dock}
      <Sheet open={advanced} onClose={() => setAdvanced(false)} title="Advanced">
        <dl className="room-advanced-list">
          {kind && <><dt>Kind</dt><dd>{kind}</dd></>}
          {folder && <><dt>Folder</dt><dd>{folder}</dd></>}
          <dt>Shell</dt><dd>{shellPath || "The login shell of this computer's account"}</dd>
          <dt>Profile files read</dt><dd>~/.profile and, for bash, ~/.bashrc; for zsh ~/.zprofile and ~/.zshrc</dd>
          <dt>Terminals</dt><dd>{terminalCountLine({ counted: terminalsCounted(status), open: alive.length, max: status.terminal_max })}</dd>
          <dt>What is recorded</dt><dd>{RECORDED_LINE}</dd>
          {!status.can.files && status.isolation === "vm" && <><dt>Files</dt><dd>Files live inside the separate computer. Use its screen.</dd></>}
        </dl>
      </Sheet>
    </div>
  );
}
