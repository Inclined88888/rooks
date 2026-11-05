import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../util";

type TryStatus = {
  available?: boolean;
  running?: boolean;
  screen?: boolean;
  driver?: string;
  label?: string;
  note?: string;
  last_checkpoint?: { name?: string; label?: string } | null;
};

type RunResult = { ok?: boolean; stdout?: string; stderr?: string; error?: string };

function plainKind(driver?: string): string {
  if (driver === "qemu") return "A private Linux computer";
  if (driver === "nested") return "A private desktop";
  if (driver === "shell") return "A private folder";
  return "A spare computer on this machine";
}

/** Practice computer: start, save a point, start over. Driver names stay under Advanced. */
export default function TryRoomPage() {
  const toast = useToast();
  const [st, setSt] = useState<TryStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "stopping">("idle");
  const [shot, setShot] = useState(0);
  const [shotOk, setShotOk] = useState(true);
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState("");
  const [runningCmd, setRunningCmd] = useState(false);

  const refresh = () => api<TryStatus>("/try/status").then(setSt).catch(() => setSt({ available: false, note: "Not on this computer yet." }));

  useEffect(() => { refresh(); }, []);

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setPhase(path === "up" ? "starting" : path === "down" ? "stopping" : "idle");
    try {
      await api(`/try/${path}`, { method: "POST", body });
      await refresh();
      if (path === "up") { setShotOk(true); setShot((n) => n + 1); }
      if (path === "down" || path === "reset") setOut("");
      toast.ok(path === "up" ? "Practice computer is on" : path === "down" ? "Practice computer stopped" : path === "checkpoint" ? "Point saved" : "Started over");
    } catch (e) {
      toast.err(e);
    } finally {
      setPhase("idle");
    }
  };

  const runCmd = async (e: FormEvent) => {
    e.preventDefault();
    const command = cmd.trim();
    if (!command || !st?.running) return;
    setRunningCmd(true);
    try {
      const r = await api<RunResult>("/try/run", { method: "POST", body: { command, timeout: 20 } });
      const text = [r.stdout, r.stderr, r.error].filter(Boolean).join("\n").trim();
      setOut(text || (r.ok ? "Done." : "The command did not finish."));
    } catch (err) {
      toast.err(err);
    } finally {
      setRunningCmd(false);
    }
  };

  const statusWord = phase === "starting" ? "Starting" : phase === "stopping" ? "Stopping" : st?.running ? "On" : "Off";
  const folderOnly = st?.screen === false;

  return (
    <div className="page practice-page">
      <header className="cursor-customize-head">
        <div>
          <h1>Practice computer</h1>
          <p className="muted">A spare computer on this machine. Your real desktop stays alone.</p>
        </div>
      </header>

      {st === null && <p className="muted">Checking…</p>}
      {st && !st.available && <p className="muted">{st.note || "Not on this computer yet."}</p>}
      {st?.available && (
        <div className="card col" style={{ gap: 12, maxWidth: 640 }}>
          <p style={{ margin: 0 }}><strong>{statusWord}</strong></p>
          {st.last_checkpoint?.name && (
            <p className="small muted" style={{ margin: 0 }}>Last saved point: {st.last_checkpoint.label || st.last_checkpoint.name}</p>
          )}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {!st.running
              ? <button type="button" className="btn primary" disabled={phase !== "idle"} onClick={() => act("up")}>Start</button>
              : <button type="button" className="btn" disabled={phase !== "idle"} onClick={() => act("down")}>Stop</button>}
            <button type="button" className="btn" disabled={phase !== "idle" || !st.running} onClick={() => act("checkpoint", { label: "Saved point" })}>Save a point</button>
            <button type="button" className="btn" disabled={phase !== "idle"} onClick={() => act("reset", {})}>Start over</button>
          </div>
          {st.running && folderOnly && (
            <form className="col" style={{ gap: 8 }} onSubmit={runCmd}>
              <label className="small muted" htmlFor="practice-cmd">Try a command</label>
              <div className="row" style={{ gap: 8 }}>
                <input id="practice-cmd" className="input grow" value={cmd} onChange={(e) => setCmd(e.target.value)}
                  placeholder="For example, ls" aria-label="Command" maxLength={500}
                  disabled={phase !== "idle" || runningCmd} />
                <button className="btn primary" disabled={!cmd.trim() || phase !== "idle" || runningCmd}>Run</button>
              </div>
              {out && <pre className="practice-out">{out}</pre>}
            </form>
          )}
          {st.running && !folderOnly && shotOk ? (
            <img
              className="practice-shot"
              alt="Practice computer screen"
              src={`/api/try/screenshot?k=${shot}`}
              onError={() => setShotOk(false)}
            />
          ) : !st.running ? (
            <p className="small muted" style={{ margin: 0 }}>The screen shows up here once it is on.</p>
          ) : null}
          <details>
            <summary className="small muted">Advanced</summary>
            <p className="small muted">{plainKind(st.driver)}</p>
          </details>
        </div>
      )}
      {toast.node}
    </div>
  );
}
