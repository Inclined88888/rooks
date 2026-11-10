/**
 * One shared poller per kind of data (docs/design/0003-workroom.md, section 6, principle 4). Every part of the app that
 * shows the data calls start() and gets the same answers; the network is asked once per tick however many parts look.
 *
 *  - Visibility aware: `every` is told whether the tab is hidden and may slow down or return null to stop. When the
 *    tab comes back the poller asks at once if its last answer is older than the visible interval.
 *  - No overlap: an ask while one is in flight is folded into one more ask after it.
 *  - refresh() asks now (after an action) instead of at the next tick.
 *
 * The clock, timers and the page's visibility are injected (`env`) so the cadence can be tested with a fake clock.
 */

export type PollEnv = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  hidden: () => boolean;
  /** Call fn whenever the tab is shown or hidden; returns an unsubscribe. */
  onVisibility: (fn: () => void) => () => void;
};

export const browserEnv: PollEnv = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  hidden: () => typeof document !== "undefined" && document.hidden === true,
  onVisibility: (fn) => {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

export type PollerOptions = {
  /** One ask. Errors are the caller's to keep (the poller only schedules the next one). */
  load: () => Promise<void>;
  /** Milliseconds until the next ask, or null to wait (until refresh() or the tab is shown again). */
  every: (hidden: boolean) => number | null;
  env?: PollEnv;
};

export type Poller = {
  /** One more part of the app shows the data. Returns the matching stop. */
  start: () => () => void;
  /** Ask now. */
  refresh: () => Promise<void>;
  /** Ask again on the cadence from now (after the cadence itself changed, say a turn started). */
  reschedule: () => void;
  users: () => number;
};

export function createPoller(opts: PollerOptions): Poller {
  const env = opts.env ?? browserEnv;
  let users = 0;
  let timer: unknown;
  let inflight: Promise<void> | null = null;
  let wanted = false;
  let lastAt = -Infinity;
  let unwatch: (() => void) | null = null;

  const clear = () => { if (timer !== undefined) { env.clearTimeout(timer); timer = undefined; } };

  const schedule = () => {
    clear();
    if (users <= 0) return;
    const ms = opts.every(env.hidden());
    if (ms === null) return;
    timer = env.setTimeout(() => { timer = undefined; void tick(); }, Math.max(0, ms));
  };

  const tick = (): Promise<void> => {
    if (inflight) { wanted = true; return inflight; }
    clear();
    lastAt = env.now();
    inflight = (async () => {
      try { await opts.load(); } catch { /* the store keeps its last answer */ }
    })().finally(() => {
      inflight = null;
      if (wanted) { wanted = false; void tick(); } else schedule();
    });
    return inflight;
  };

  const onVisibility = () => {
    if (users <= 0) return;
    if (env.hidden()) { schedule(); return; }
    const ms = opts.every(false);
    if (ms === null || env.now() - lastAt >= ms) void tick();
    else schedule();
  };

  return {
    start() {
      users += 1;
      if (users === 1) {
        unwatch = env.onVisibility(onVisibility);
        void tick();
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        users -= 1;
        if (users === 0) { clear(); unwatch?.(); unwatch = null; }
      };
    },
    refresh: () => tick(),
    reschedule: () => { if (!inflight) schedule(); },
    users: () => users,
  };
}
