import { FormEvent, useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { api } from "../api";
import { LiveShot } from "../motion";
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
  if (driver === "display") return "A separate screen";
  return "A spare computer on this machine";
}

/** Virtual computer: start, save a point, start over. Driver names stay under Advanced. */
export default function TryRoomPage({ bare = false }: { bare?: boolean }) {
  const toast = useToast();
  const [st, setSt] = useState<TryStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "stopping">("idle");
  const [shot, setShot] = useState(0);
  const [shotOk, setShotOk] = useState(true);
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState("");
  const [runningCmd, setRunningCmd] = useState(false);

  const refresh = () => api<TryStatus>("/try/status").then(setSt).catch(() => setSt({ available: false, note: "Not on this computer yet." }));

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        let s = await api<TryStatus>("/try/status");
        if (stop) return;
        if (s.available && !s.running) {
          s = { ...s, ...(await api<TryStatus>("/try/up", { method: "POST", body: {} })), available: true };
          if (!stop) setShot((n) => n + 1);
        }
        if (!stop) setSt(s);
      } catch {
        if (!stop) setSt({ available: false, note: "Not on this computer yet." });
      }
    })();
    return () => { stop = true; };
  }, []);

  useEffect(() => {
    if (!st?.running || st.screen === false) return;
    const t = window.setInterval(() => setShot((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [st?.running, st?.screen]);

  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setPhase(path === "up" ? "starting" : path === "down" ? "stopping" : "idle");
    try {
      await api(`/try/${path}`, { method: "POST", body });
      await refresh();
      if (path === "up") { setShotOk(true); setShot((n) => n + 1); }
      if (path === "down" || path === "reset") setOut("");
      toast.ok(path === "up" ? "Virtual computer is on" : path === "down" ? "Virtual computer stopped" : path === "checkpoint" ? "Point saved" : "Started over");
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

  const poke = async (path: string, body: Record<string, unknown>) => {
    try {
      await api(`/try/${path}`, { method: "POST", body });
      setShot((n) => n + 1);
    } catch (err) {
      toast.err(err);
    }
  };

  const onScreenClick = (e: MouseEvent<HTMLDivElement>) => {
    const img = e.currentTarget.querySelector("img");
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.round((e.clientX - rect.left) * (img.naturalWidth / rect.width));
    const y = Math.round((e.clientY - rect.top) * (img.naturalHeight / rect.height));
    void poke("click", { x, y });
    e.currentTarget.focus();
  };

  const onScreenKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    if (e.key === "Enter") void poke("key", { keys: "Return" });
    else if (e.key === "Backspace") void poke("key", { keys: "BackSpace" });
    else if (e.key.length === 1) void poke("type", { text: e.key });
  };

  const statusWord = phase === "starting" ? "Starting" : phase === "stopping" ? "Stopping" : st?.running ? "On" : "Off";
  const folderOnly = st?.screen === false;

  return (
    <div className="page practice-page">
      <header className="cursor-customize-head">
        <div>
          {!bare && <h1>Virtual computer</h1>}
          <p className="muted">
            {folderOnly
              ? "A private folder on this computer. Commands run as you."
              : "A separate screen on this computer. Your own desktop stays alone."}
          </p>
        </div>
      </header>

      {st === null && <p className="muted">Checking…</p>}
      {st && !st.available && <p className="muted">{st.note || "Not on this computer yet."}</p>}
      {st?.available && (
        <div className="card col" style={{ gap: 12, maxWidth: folderOnly ? 640 : 980 }}>
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
              <label className="small muted" htmlFor="practice-cmd">Try a command. Commands run as you, in this folder.</label>
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
            <div
              className="virtual-screen"
              tabIndex={0}
              role="application"
              aria-label="Virtual computer screen. Click it, then type."
              onClick={onScreenClick}
              onKeyDown={onScreenKey}
            >
              <LiveShot
                src={`/api/try/screenshot?k=${shot}`}
                alt="Virtual computer screen"
                scanning={phase === "starting"}
              />
              <p className="small muted" style={{ margin: "8px 0 0" }}>Click the screen, then type. It is not your Mac terminal.</p>
            </div>
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
