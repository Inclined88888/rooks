/**
 * Package C helpers (premium pass): one way to load data with a loading, an error and a reload, and the few layout
 * pieces the agent and memory pages share. Built on the primitives in src/ui; styles in pages/agents/agents.css.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorState, Loading } from "../../ui";
import "./agents.css";

export type Loaded<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void; set: (v: T) => void };

/** Load once (and again when deps change). A reload keeps the old data on screen while the new answer comes. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fn = useRef(load);
  fn.current = load;
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    fn.current().then(
      (v) => { if (n === seq.current) { setData(v); setError(null); setLoading(false); } },
      (e) => { if (n === seq.current) { setError(e ?? new Error("failed")); setLoading(false); } },
    );
  }, []);
  useEffect(reload, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload, set: setData };
}

/** A sentence for an error a person can act on. The technical text stays out of the way. */
export function plainError(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!m || /fetch|network|failed to|5\d\d|internal/i.test(m)) return "The app did not answer. Check it is still running, then try again.";
  return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}

/** Loading, then the error with Try again, then the content. `rows` sizes the skeleton. */
export function Gate<T>({ state, rows = 3, title = "That did not load", children }: { state: Loaded<T>; rows?: number; title?: string; children: (data: T) => ReactNode }) {
  if (state.data === null && state.error) return <ErrorState title={title} line={plainError(state.error)} onRetry={state.reload} />;
  if (state.data === null) return <Loading rows={rows} />;
  return <>{children(state.data)}</>;
}

/** A list on the left and the open item on the right; one column on a phone. `solo` drops the list column (nothing in it yet,
 *  so the one empty state on the right says it once). */
export function Split({ list, children, narrow, solo }: { list: ReactNode; children: ReactNode; narrow?: boolean; solo?: boolean }) {
  if (solo) return <div className="ag-split-main">{children}</div>;
  return (
    <div className={`ag-split${narrow ? " is-narrow" : ""}`}>
      <div className="ag-split-list">{list}</div>
      <div className="ag-split-main">{children}</div>
    </div>
  );
}

/** A short plain status line beside a job, run or meeting. */
export function StatusText({ live, children }: { live?: boolean; children: ReactNode }) {
  return <span className={`ag-status${live ? " is-live" : ""}`}>{live && <span className="ag-live-dot" aria-hidden="true" />}{children}</span>;
}

export function ago(iso?: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z").getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
