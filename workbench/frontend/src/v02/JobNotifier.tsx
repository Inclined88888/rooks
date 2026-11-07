// Desktop notifications for the jobs board (feat/v02-automations): a job needs your OK, finished, or failed.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { inBackground, notify } from "../desktop";
import { onNotices, type Notice } from "../shell/presence";
import "./v02.css";

export default function JobNotifier() {
  const [pill, setPill] = useState<Notice | null>(null);
  const navigate = useNavigate();

  // The notices ride on the shell's one pulse (shell/presence.ts): no poller of its own.
  useEffect(() => onNotices((list) => {
    for (const n of list) {
      setPill(n);
      if (inBackground()) void notify(n.title, n.body, { tag: `job-${n.job_id}`, onClick: () => navigate("/jobs") }); // native in the desktop app
    }
  }), [navigate]);

  useEffect(() => {
    if (!pill) return;
    const t = setTimeout(() => setPill(null), 8000);
    return () => clearTimeout(t);
  }, [pill]);

  if (!pill) return null;
  return (
    <div className={`job-pill ${pill.kind}`} role="status">
      <button className="job-pill-main" onClick={() => { navigate("/jobs"); setPill(null); }}>
        <strong>{pill.title}</strong>{pill.body && <span className="small">{pill.body}</span>}
      </button>
      <button className="btn ghost sm icon" aria-label="Dismiss" onClick={() => setPill(null)}>×</button>
    </div>
  );
}
