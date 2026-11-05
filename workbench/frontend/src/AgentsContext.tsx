import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, type Task } from "./api";

type Job = { id: string; goal?: string; task?: string; status: string; agent_name?: string; created_at?: number };
type MailAccount = { id: number; name?: string; email?: string };
type MailRow = { uid: string; from: string; subject: string; date: string; unread: boolean };

function shortAgoTs(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

const live = (status: string) => status === "running" || status === "queued" || status === "waiting" || status === "needs_approval";

/** Right side: mail and tasks. A job in progress shows here, then this part goes away when it finishes. */
export default function AgentsContext({
  browserEnabled,
  deskEnabled,
}: {
  browserEnabled?: boolean;
  deskEnabled?: boolean;
}) {
  const location = useLocation();
  const [runs, setRuns] = useState<Job[]>([]);
  const [desk, setDesk] = useState<Job[]>([]);
  const [browser, setBrowser] = useState<Job[]>([]);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [mail, setMail] = useState<MailRow[] | null>(null);
  const [mailReady, setMailReady] = useState<boolean | null>(null);

  useEffect(() => {
    let stop = false;
    const loadJobs = () => {
      api<Job[]>("/cli-agents/runs").then((r) => { if (!stop) setRuns(r.slice(0, 8)); }).catch(() => undefined);
      if (deskEnabled) api<Job[]>("/desk/jobs").then((r) => { if (!stop) setDesk(r.slice(0, 6)); }).catch(() => undefined);
      if (browserEnabled) api<Job[]>("/browser/jobs").then((r) => { if (!stop) setBrowser(r.slice(0, 6)); }).catch(() => undefined);
    };
    const loadWork = () => {
      api<Task[]>("/tasks").then((r) => { if (!stop) setTasks(r); }).catch(() => { if (!stop) setTasks([]); });
      api<MailAccount[]>("/mail/accounts").then(async (accounts) => {
        if (stop) return;
        const first = accounts[0];
        if (!first) {
          setMailReady(false);
          setMail([]);
          return;
        }
        setMailReady(true);
        try {
          const rows = await api<MailRow[]>(`/mail/${first.id}/messages`);
          if (!stop) setMail(rows.slice(0, 5));
        } catch {
          if (!stop) setMail([]);
        }
      }).catch(() => { if (!stop) { setMailReady(false); setMail([]); } });
    };
    loadJobs();
    loadWork();
    const jobs = window.setInterval(loadJobs, 10000);
    const work = window.setInterval(loadWork, 30000);
    return () => { stop = true; clearInterval(jobs); clearInterval(work); };
  }, [deskEnabled, browserEnabled, location.key]);

  const working = [
    ...runs.filter((r) => live(r.status)).map((r) => ({
      key: `run-${r.id}`,
      title: r.task || r.goal || "Code",
      meta: [r.agent_name, shortAgoTs(r.created_at)].filter(Boolean).join(" · "),
      to: `/code/${r.id}`,
    })),
    ...desk.filter((j) => live(j.status)).map((j) => ({
      key: `desk-${j.id}`,
      title: j.goal || "Computer",
      meta: shortAgoTs(j.created_at) || "Working",
      to: `/computer/${j.id}`,
    })),
    ...browser.filter((j) => live(j.status)).map((j) => ({
      key: `br-${j.id}`,
      title: j.goal || "Browser",
      meta: shortAgoTs(j.created_at) || "Working",
      to: `/browser/${j.id}`,
    })),
  ].slice(0, 6);

  const openTasks = (tasks ?? []).filter((t) => t.status !== "done").slice(0, 6);

  return (
    <aside className="agents-context" aria-label="Mail and tasks">
      <div className="agents-context-scroll">
        {working.length > 0 && (
          <>
            <div className="agents-context-label">Working</div>
            <div className="agents-work">
              {working.map((w) => (
                <Link key={w.key} to={w.to} className="agents-work-row live">
                  <span className="agents-dot on" aria-hidden />
                  <span className="grow truncate">
                    <span className="agents-chat-title truncate">{w.title}</span>
                    {w.meta && <span className="agents-chat-meta">{w.meta}</span>}
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}

        <div className="agents-context-label">Mail</div>
        <div className="agents-work">
          {mail === null && <p className="agents-empty">Checking the mailbox…</p>}
          {mail && mailReady === false && (
            <Link to="/mail" className="agents-work-row">
              <span className="grow truncate">
                <span className="agents-chat-title">Add a mailbox</span>
                <span className="agents-chat-meta">New mail shows up here</span>
              </span>
            </Link>
          )}
          {mail && mailReady && !mail.length && <p className="agents-empty">Nothing new</p>}
          {mail?.map((m) => (
            <Link key={m.uid} to="/mail" className="agents-work-row">
              <span className={`agents-dot${m.unread ? " on" : ""}`} aria-hidden />
              <span className="grow truncate">
                <span className="agents-chat-title truncate">{m.subject || "(no subject)"}</span>
                <span className="agents-chat-meta truncate">{m.from.replace(/<.*>/, "").trim() || m.from}</span>
              </span>
            </Link>
          ))}
        </div>

        <div className="agents-context-label">Tasks</div>
        <div className="agents-work">
          {tasks === null && <p className="agents-empty">Loading…</p>}
          {tasks && !openTasks.length && (
            <Link to="/tasks" className="agents-work-row">
              <span className="grow truncate">
                <span className="agents-chat-title">No open tasks</span>
                <span className="agents-chat-meta">Add one when you have work to do</span>
              </span>
            </Link>
          )}
          {openTasks.map((t) => (
            <Link key={t.id} to="/tasks" className="agents-work-row">
              <span className={`agents-dot${t.status === "doing" ? " on" : ""}`} aria-hidden />
              <span className="grow truncate">
                <span className="agents-chat-title truncate">{t.title}</span>
                {(t.project || t.due) && <span className="agents-chat-meta truncate">{[t.project, t.due].filter(Boolean).join(" · ")}</span>}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </aside>
  );
}
