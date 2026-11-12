/**
 * The new-host alert of the egress journal (TODO #590, T3).
 *
 * The criterion is "a host this project's missions never reached before",
 * not "any connection": a mission talks to its backend, git and a registry
 * hundreds of times a turn, and an alert per connection would bury the one
 * that matters. A project learns its usual hosts once; what stands out after
 * that is a place it never went — where an injected prompt would send data.
 *
 * Dedup is two-layered. The known-hosts table makes each (project, host)
 * pair new only once, whichever mission meets it. Per mission, the first new
 * host alerts at once and opens a quiet window; the new hosts met during it
 * are held and sent together when it closes, so a mission crawling fifty
 * fresh hosts raises a handful of notifications, never fifty.
 */

export interface NewHostAlert {
  missionId: string;
  projectKey: string;
  hosts: string[];
  /** New hosts met but not listed, beyond `MAX_LISTED`. */
  more: number;
}

export interface NewHostAlertsOptions {
  send: (alert: NewHostAlert) => void;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const NEW_HOST_ALERT_WINDOW_MS = 15 * 60 * 1000;
/** Hosts named in one notification; the rest are counted. */
export const MAX_LISTED = 10;

interface MissionState {
  projectKey: string;
  pending: string[];
  more: number;
  timer: unknown;
}

export interface NewHostAlerts {
  noteNewHost(missionId: string, projectKey: string, host: string): void;
  stop(): void;
}

export function createNewHostAlerts(opts: NewHostAlertsOptions): NewHostAlerts {
  const windowMs = opts.windowMs ?? NEW_HOST_ALERT_WINDOW_MS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    // A held alert must never keep the daemon (or a test) alive.
    handle.unref();
    return handle;
  });
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const missions = new Map<string, MissionState>();

  function send(alert: NewHostAlert): void {
    try {
      opts.send(alert);
    } catch {
      // A lost alert must not break the proxy; the journal still holds the host.
    }
  }

  function arm(missionId: string): unknown {
    return setTimer(() => {
      const state = missions.get(missionId);
      if (!state) return;
      if (state.pending.length === 0) {
        missions.delete(missionId);
        return;
      }
      send({ missionId, projectKey: state.projectKey, hosts: state.pending, more: state.more });
      state.pending = [];
      state.more = 0;
      state.timer = arm(missionId);
    }, windowMs);
  }

  return {
    noteNewHost(missionId, projectKey, host) {
      const state = missions.get(missionId);
      if (!state) {
        send({ missionId, projectKey, hosts: [host], more: 0 });
        missions.set(missionId, { projectKey, pending: [], more: 0, timer: arm(missionId) });
        return;
      }
      if (state.pending.includes(host)) return;
      if (state.pending.length < MAX_LISTED) state.pending.push(host);
      else state.more += 1;
    },
    stop() {
      for (const state of missions.values()) clearTimer(state.timer);
      missions.clear();
    },
  };
}
