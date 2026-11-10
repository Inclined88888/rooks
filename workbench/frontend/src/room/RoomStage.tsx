/**
 * The Room on the Stage (the right pane, "Watch beside the chat"), registered as the "room" surface
 * (src/stage/surfaces.tsx). A compact desk (docs/design/0006-room-desktop.md, section 7.2): the goal line, one window at
 * a time (Screen when real, else the Terminal, the very same panes as the page through the "room" keeper), a reduced
 * dock of icon buttons that swaps the window shown, and the honest line. The frame's controls keep Start or Stop, the
 * modes, Save a point, Start over, Hand off a file, Open the Room page and Close. Never two windows side by side.
 */
import { Bookmark, Folder, Globe, Monitor, SquareTerminal, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Stage } from "../shell/StageHost";
import { TerminalSlot } from "../terminalHost";
import { IconButton, StageFrame } from "../ui";
import { BrowserWindow } from "./BrowserWindow";
import { dockItems, pickActive, windowsFor, type WindowId } from "./desk";
import { FilesWindow } from "./FilesWindow";
import { PointsWindow } from "./PointsWindow";
import { CommandView, HonestLine, roomNotReady, useRoomFrame } from "./RoomView";
import { TerminalWindow } from "./TerminalWindow";
import { useRoomStatus } from "./status";
import { useTerms } from "./terms";

const ICON: Record<WindowId, LucideIcon> = { terminal: SquareTerminal, commands: SquareTerminal, browser: Globe, files: Folder, points: Bookmark, screen: Monitor };

export function RoomStage({ stage, close }: { stage: Stage; close: () => void }) {
  // the same store the frame reads: which window shows decides whether the frame keeps its point verbs
  const status = useRoomStatus();
  const ui = useTerms();
  const offered = windowsFor(status);
  const [pick, setPick] = useState<WindowId | null>(null);
  const shown: WindowId | null = pick && offered.includes(pick) ? pick : offered[0] ?? null;
  const f = useRoomFrame({ mode: "stage", goal: stage.goal, onClose: close, pointsShown: shown === "points" });
  const terminal = (() => { const id = pickActive(status.terminals, ui.active); return status.terminals.find((t) => t.id === id && t.alive) ?? null; })();

  let main: ReactNode = roomNotReady(status);
  if (!main) {
    if (shown === "screen") main = f.picture;
    else if (shown === "terminal") main = <TerminalWindow bare status={status} act={f.act} slot={<TerminalSlot kind="room" />} />;
    else if (shown === "browser") main = <BrowserWindow status={status} act={f.act} stale={!status.reachable} />;
    else if (shown === "commands") main = <CommandView status={status} />;
    else if (shown === "files") main = <FilesWindow status={status} terminal={terminal} onHandOff={f.openHandoff} />;
    else if (shown === "points") main = <PointsWindow status={status} act={f.act} stale={!status.reachable} />;
  }
  const items = dockItems(status);
  return (
    <StageFrame title="The Room" label={f.label} live={f.live} captured={f.captured} controls={f.controls} className="room-frame room-stage">
      {f.goal}
      <div className="room-stage-window">{main}</div>
      {status.available && (
        <div className="room-stage-dock" id="room-stage-dock" tabIndex={-1}>
          {items.length > 1 && (
            <span className="room-stage-dock-items" role="toolbar" aria-label="Windows">
              {items.map((d) => {
                const Icon = ICON[d.id];
                return <IconButton key={d.id} label={d.label} size="sm" active={shown === d.id} onClick={() => setPick(d.id)}><Icon size={15} /></IconButton>;
              })}
            </span>
          )}
          <HonestLine status={status} className="room-honest room-stage-honest" />
        </div>
      )}
      {f.panels}
    </StageFrame>
  );
}

export default RoomStage;
