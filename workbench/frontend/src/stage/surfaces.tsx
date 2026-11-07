/**
 * The Stage's surfaces (docs/design/0003-workroom.md, section 3): how the Room, a browser job, a desk job and the
 * terminal draw inside the right pane. registerStageSurfaces() runs once when the app starts; a chat watch event
 * then opens the Stage through openStage() and each surface draws from its own source: the Room from its own screen
 * (RoomStage, with the honesty check), a job from its job's screenshot route (chat/watch.ts says which one), the
 * terminal from its own page. Every surface closes with its own control.
 */
import { SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { watchSource } from "../chat/watch";
import { registerStageSurface, type Stage } from "../shell/StageHost";
import { EmptyState, IconButton, StageFrame } from "../ui";
import "./stage.css";

const RoomStage = lazy(() => import("../room/RoomStage"));
const ACTIVE = new Set(["running", "queued", "waiting"]);

function CloseStage({ close }: { close: () => void }) {
  return <IconButton label="Close the Stage" size="sm" onClick={() => close()}><X size={15} /></IconButton>;
}

/**
 * A job on a browser or on this computer: the latest frame every 2 s while the job runs, then an honest line. The
 * job itself is asked every 5 s whether it still runs; its page has every step and the take over controls.
 */
function WatchStage({ stage, close }: { stage: Stage; close: () => void }) {
  const browser = stage.surface === "browser";
  const id = stage.jobId || "";
  const source = watchSource({ surface: browser ? "browser" : "computer", job_id: id });
  const [tick, setTick] = useState(0);
  const [gone, setGone] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { setGone(false); setTick(0); setStatus(null); }, [id]);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const ask = () => api<{ status?: string }>(`${browser ? "/browser/jobs/" : "/desk/jobs/"}${encodeURIComponent(id)}`)
      .then((j) => { if (!stop) setStatus(j.status || "unknown"); })
      .catch(() => { if (!stop) setStatus("unknown"); });
    void ask();
    const t = window.setInterval(() => void ask(), 5000);
    return () => { stop = true; window.clearInterval(t); };
  }, [id, browser]);
  const active = status === null ? null : ACTIVE.has(status);
  const showsScreen = !!id && active !== false && !gone;
  useEffect(() => {
    if (!showsScreen) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 2000);
    return () => window.clearInterval(t);
  }, [showsScreen, id]);
  const where = browser ? "the browser" : "your computer";
  const title = browser ? "The browser" : "Your computer";
  return (
    <StageFrame title={title} label={stage.goal || `A job on ${where}`} live={active === true} captured={false}
      controls={(
        <>
          {id && <Link className="ui-btn ui-btn-secondary ui-btn-sm" to={source.open}>{active ? "Take over" : "Open the job"}</Link>}
          <span className="stage-space" />
          <CloseStage close={close} />
        </>
      )}>
      {showsScreen
        ? <div className="stage-shot"><img src={`${source.screenshot}?k=${tick}`} alt={`What is on ${where} now`} onError={() => { if (tick > 1) setGone(true); }} /></div>
        : (
          <EmptyState title={!id ? "No job to show." : status === null ? "Looking for the job…" : "This job's screen is not live any more."}
            line={id ? "Open the job to see every step it took." : undefined} />
        )}
    </StageFrame>
  );
}

/** The terminal keeps its own page (its shells stay mounted there); the Stage points to it instead of pretending. */
function TerminalStage({ stage, close }: { stage: Stage; close: () => void }) {
  return (
    <StageFrame title="The terminal" label={stage.goal || "Rooks is working in the terminal"} live captured={false}
      controls={<><Link className="ui-btn ui-btn-secondary ui-btn-sm" to="/terminal">Open the terminal</Link><span className="stage-space" /><CloseStage close={close} /></>}>
      <EmptyState icon={<SquareTerminal size={24} />} title="The terminal runs on its own page." line="Open it to watch the commands as they run." />
    </StageFrame>
  );
}

function RoomLoading() {
  return <StageFrame title="The Room" label="Checking the Room…" live={false} captured={false} controls={null}><p className="stage-line">Checking the Room…</p></StageFrame>;
}

let registered = false;

/** Called once when the app starts. Registering again is a no-op. */
export function registerStageSurfaces() {
  if (registered) return;
  registered = true;
  registerStageSurface("room", (stage, close) => <Suspense fallback={<RoomLoading />}><RoomStage stage={stage} close={close} /></Suspense>);
  registerStageSurface("browser", (stage, close) => <WatchStage stage={stage} close={close} />);
  registerStageSurface("desktop", (stage, close) => <WatchStage stage={stage} close={close} />);
  registerStageSurface("terminal", (stage, close) => <TerminalStage stage={stage} close={close} />);
}
