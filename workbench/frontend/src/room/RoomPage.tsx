/**
 * The Room page (/room): the live view in its frame, the saved points with Start over from each one, and what the
 * Room is in plain words. The technical details (the kind of Room and its folder) sit under Advanced only.
 */
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, StageFrame } from "../ui";
import { useRoomActions, useRoomFrame } from "./RoomView";
import { advancedDetails, isolationWords, NOT_HERE_LINE, pointLine, roomStateWords } from "./words";

export default function RoomPage() {
  const f = useRoomFrame({ mode: "page" });
  const status = f.status;
  const act = useRoomActions();
  const [confirm, setConfirm] = useState<string | null>(null);
  const points = status.checkpoints ?? [];
  const { kind, folder } = advancedDetails(status);
  return (
    <div className="page room-page">
      <div className="page-head">
        <div>
          <h1>The Room</h1>
          <p>Rooks's own computer inside this app. Watch it work, step in, hand it back, save a point and start over.</p>
        </div>
        <Badge tone={status.running ? "live" : "neutral"}>{roomStateWords(status)}</Badge>
      </div>
      <div className="room-page-grid">
        <StageFrame title="The Room" label={f.label} live={f.live} captured={f.captured} controls={f.controls} className="room-frame room-page-frame">
          {f.body}
        </StageFrame>
        <aside className="room-side">
          <Card padding="sm" as="section" aria-labelledby="room-points-title">
            <h2 id="room-points-title" className="room-side-title">Saved points</h2>
            {!points.length
              ? <p className="room-side-line">No saved points yet. Save one before trying something you might want to undo.</p>
              : (
                <ol className="room-points">
                  {points.map((p) => (
                    <li key={p.name} className="room-point">
                      <span className="room-point-text">{pointLine(p.name)}</span>
                      {confirm === p.name
                        ? (
                          <span className="room-point-confirm">
                            <Button size="sm" variant="danger" busy={act.busy === "reset"} onClick={async () => { const r = await act.startOver(p.name); if (r?.verified) setConfirm(null); }}>Yes, start over</Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)} disabled={act.busy === "reset"}>Keep it</Button>
                          </span>
                        )
                        : <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => setConfirm(p.name)}>Start over from here</Button>}
                    </li>
                  ))}
                </ol>
              )}
            {status.pruned?.removed?.length
              ? <p className="room-side-line">Older points are removed once there are {status.checkpoint_limit || 20}; {status.pruned.removed.length} removed so far.</p>
              : null}
          </Card>
          <Card padding="sm" as="section" aria-labelledby="room-what-title">
            <h2 id="room-what-title" className="room-side-title">What the Room is</h2>
            <p className="room-side-line">{status.checked ? status.label || NOT_HERE_LINE : "Checking…"}</p>
            {status.note && <p className="room-side-line">{status.note}</p>}
            {status.available && (
              <p className="room-side-badges">
                <Badge tone="neutral">{isolationWords(status.isolation, !!status.offline)}</Badge>
                {status.offline && <Badge tone="neutral">Offline</Badge>}
              </p>
            )}
            {(kind || folder) && (
              <details className="room-advanced">
                <summary>Advanced</summary>
                <dl className="room-advanced-list">
                  {kind && <><dt>Kind</dt><dd>{kind}</dd></>}
                  {folder && <><dt>Folder</dt><dd>{folder}</dd></>}
                </dl>
              </details>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
