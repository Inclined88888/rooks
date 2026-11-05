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
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)} title="Disposable computer on this machine">
        Try Room
      </button>
    );
  }

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      await api(`/try/${path}`, { method: "POST", body });
      await refresh();
      toast.ok(path === "up" ? "Try Room is on" : path === "down" ? "Try Room stopped" : "Done");
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
    <div aria-label="Try Room">
      <div className="row">
        <strong className="grow">Try Room</strong>
        <button type="button" className="btn ghost sm" onClick={close}>Close</button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        A disposable computer on this machine. Your real desktop stays alone.
      </p>
      {st && !st.available && <p className="small muted">{st.note || "Not installed yet."}</p>}
      {st?.available && (
        <>
          <p className="small">{st.running ? `On · ${st.label || st.driver}` : `Off · ${st.label || st.driver || "ready"}`}</p>
          {st.last_checkpoint?.name && <p className="small muted">Checkpoint: {st.last_checkpoint.label || st.last_checkpoint.name}</p>}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn sm" disabled={busy} onClick={() => act(st.running ? "down" : "up")}>
              {st.running ? "Stop" : "Start"}
            </button>
            <button type="button" className="btn ghost sm" disabled={busy || !st.running} onClick={() => act("checkpoint", { label: "from chat" })}>
              Checkpoint
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => act("reset", {})}>
              Reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}
