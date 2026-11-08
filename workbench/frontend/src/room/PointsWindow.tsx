/**
 * The Saved points window (docs/design/0006-room-desktop.md, section 3.3): copies of the Room's folder, newest first,
 * each with Start over from here and its inline confirm, which names how many terminals close. Save a point opens a
 * one-field row at the top. Both are said done only when the service verified them (useRoomActions).
 */
import { Bookmark, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, Input, List, Row } from "../ui";
import { focusWindowTitle, RoomWindow, type RoomActions } from "./RoomView";
import type { RoomState } from "./status";
import { closeCount, pointLine } from "./words";

/** What the Room bar asked of this window: open the naming row, or the confirm on one point. `n` counts the asks. */
export type PointsAsk = { kind: "save" | "over"; name?: string; n: number } | null;

export function PointsWindow({ status, act, ask, stale = false }: { status: RoomState; act: RoomActions; ask?: PointsAsk; stale?: boolean }) {
  const points = [...(status.checkpoints ?? [])].sort((a, b) => b.name.localeCompare(a.name));
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const alive = status.terminals.filter((t) => t.alive).length;
  const saving = act.busy === "point";

  useEffect(() => {
    if (!ask) return;
    if (ask.kind === "save") { setNaming(true); window.setTimeout(() => field.current?.focus(), 0); }
    else if (ask.name) setConfirm(ask.name);
  }, [ask?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const r = await act.savePoint(label.trim());
    if (r?.verified) {
      setNaming(false);
      setLabel("");
      window.setTimeout(() => saveRef.current?.focus(), 0);
    }
  };
  const over = async (name: string) => {
    const r = await act.startOver(name);
    if (r?.verified) {
      setConfirm(null);
      window.setTimeout(() => focusWindowTitle("points"), 0);
    }
  };
  const openNaming = () => { setNaming(true); window.setTimeout(() => field.current?.focus(), 0); };

  // While Rooks does not answer (stale) the verbs stay where they are, disabled, as on the Room bar.
  const awayTip = stale ? "Rooks did not answer. Try again in a moment." : undefined;
  const verbs = <Button ref={saveRef} size="sm" variant="primary" icon={<Bookmark size={13} />} title={awayTip} disabled={naming || !status.available || stale} onClick={openNaming}>Save a point</Button>;
  return (
    <RoomWindow id="points" title="Saved points" verbs={verbs} label="Copies of the Room's files you can start over from." stale={stale}>
      {naming && (
        <form className="room-point-form" onSubmit={(e) => { e.preventDefault(); void save(); }}
          onKeyDown={(e) => { if (e.key === "Escape" && !saving) { e.preventDefault(); setNaming(false); saveRef.current?.focus(); } }}>
          <Input ref={field} label="Name this point" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Before the upgrade"
            hint={saving ? "The Room's files are copied as they are now, so you can start over from here later. A big folder can take a while."
              : "The Room's files are copied as they are now, so you can start over from here later."} />
          <span className="room-point-form-verbs">
            <Button type="submit" size="sm" variant="primary" disabled={saving}>{saving ? "Saving…" : "Save a point"}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => { setNaming(false); saveRef.current?.focus(); }}>Cancel</Button>
          </span>
        </form>
      )}
      {!points.length
        ? (
          <EmptyState icon={<Bookmark size={24} />} title="No saved points yet." line="Save one before trying something you might want to undo." />
        )
        : (
          <List label="Saved points, newest first" className="room-points-list">
            {points.map((p) => {
              const asking = confirm === p.name;
              return (
                <Row key={p.name} title={<span className="room-point-name">{pointLine(p.name)}</span>} className={asking ? "room-point-row is-confirming" : "room-point-row"}
                  meta={asking ? `This puts the Room's files back as they were then. Anything done since is lost.${alive ? ` ${closeCount(alive)}` : ""}` : undefined}
                  actions={asking
                    ? (
                      <>
                        <Button size="sm" variant="danger" busy={act.busy === "reset"} autoFocus onClick={() => void over(p.name)}>Yes, start over</Button>
                        <Button size="sm" variant="ghost" disabled={act.busy === "reset"} onClick={() => setConfirm(null)}>Keep it</Button>
                      </>
                    )
                    : <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} title={awayTip} disabled={stale} onClick={() => setConfirm(p.name)}>Start over from here</Button>} />
              );
            })}
          </List>
        )}
      {status.pruned?.removed?.length
        ? <p className="room-window-foot">Older points are removed once there are {status.checkpoint_limit || 20}; {status.pruned.removed.length} removed so far.</p>
        : null}
    </RoomWindow>
  );
}

export default PointsWindow;
