import { useEffect, useState } from "react";
import { api } from "./api";
import { useToast } from "./util";

type TryStatus = {
  available?: boolean;
  running?: boolean;
  driver?: string;
  label?: string;
  note?: string;
  last_checkpoint?: { name?: string; label?: string } | null;
};

/** Start, checkpoint and reset the disposable Try Room. */
export function TryRoomButton({ startOpen = false, onClose }: { startOpen?: boolean; onClose?: () => void } = {}) {
  const toast = useToast();
  const [open, setOpen] = useState(startOpen);
  const [st, setSt] = useState<TryStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api<TryStatus>("/try/status").then(setSt).catch(() => setSt({ available: false }));

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);

  if (!open) {
    return (
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)} title="A spare computer on this machine">
        Practice computer
      </button>
    );
  }

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      await api(`/try/${path}`, { method: "POST", body });
      await refresh();
      toast.ok(path === "up" ? "Practice computer is on" : path === "down" ? "Practice computer stopped" : path === "checkpoint" ? "Point saved" : "Started over");
    } catch (e) {
      toast.err(e);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setOpen(false);
    onClose?.();
  };

  return (
    <div aria-label="Practice computer">
      <div className="row">
        <strong className="grow">Practice computer</strong>
        <button type="button" className="btn ghost sm" onClick={close}>Close</button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        A disposable computer on this machine. Your real desktop stays alone.
      </p>
      {st && !st.available && <p className="small muted">{st.note || "Not installed yet."}</p>}
      {st?.available && (
        <>
          <p className="small">{st.running ? "On" : "Off"}</p>
          {st.last_checkpoint?.name && <p className="small muted">Last saved point: {st.last_checkpoint.label || "Saved point"}</p>}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn sm" disabled={busy} onClick={() => act(st.running ? "down" : "up")}>
              {st.running ? "Stop" : "Start"}
            </button>
            <button type="button" className="btn ghost sm" disabled={busy || !st.running} onClick={() => act("checkpoint", { label: "Saved point" })}>
              Save a point
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => act("reset", {})}>
              Start over
            </button>
          </div>
        </>
      )}
    </div>
  );
}
