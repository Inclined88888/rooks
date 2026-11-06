'use client';

/**
 * Client side of a conversation's compaction (TODO #504, contract in
 * docs/MISSION-COMPACT.md): one POST starts it, the daemon answers 202 and
 * publishes its phases as `compact_progress` on the stream, a GET resumes it
 * after a reload.
 *
 * One store per page, shared by every surface that shows the operation — the
 * gauge's ring, its panel, the LLM dialog — so they never disagree on what is
 * running. The progress events are transient (never replayed), so a running
 * operation is also polled: a dropped stream must not leave a bar that never
 * ends.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';

export type CompactMode = 'native' | 'fork';
export type CompactPhase = 'started' | 'summarizing' | 'forking' | 'compacting' | 'done' | 'error';

/** Mirror of `CompactOperation` (orchestrator/src/mission-compact.ts). */
export type CompactOperation = {
  id: string;
  missionId: string;
  mode: CompactMode;
  phase: CompactPhase;
  backend: string;
  model: string | null;
  targetMissionId: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
};

/** What POST /compact accepts. No target = same LLM (native when declared). */
export type CompactRequest = {
  backend?: string;
  model?: string;
  reasoning_effort?: string | null;
  message?: string;
};

export type CompactSnapshot = {
  operation: CompactOperation | null;
  /** The POST is in flight. */
  starting: boolean;
  /** Why the last start was refused (409 turn_in_flight, network…), readable. */
  failure: string | null;
};

export type StartResult = { ok: true; operation: CompactOperation } | { ok: false; failure: string };

/** A terminal phase reached while this page watched the operation run. */
export type CompactSettled = { operation: CompactOperation; local: boolean };

const PHASES: readonly CompactPhase[] = ['started', 'summarizing', 'forking', 'compacting', 'done', 'error'];

export function isTerminalPhase(phase: CompactPhase): boolean {
  return phase === 'done' || phase === 'error';
}

export function isRunning(op: CompactOperation | null): boolean {
  return !!op && !isTerminalPhase(op.phase);
}

/** Share of the bar filled at each phase: the steps the daemon names, never a
 *  made-up percentage of a model's turn. */
export function compactProgress(op: Pick<CompactOperation, 'mode' | 'phase'>): number {
  if (isTerminalPhase(op.phase)) return 1;
  const steps: readonly CompactPhase[] = op.mode === 'native'
    ? ['started', 'compacting']
    : ['started', 'summarizing', 'forking'];
  const at = steps.indexOf(op.phase);
  return (Math.max(0, at) + 1) / (steps.length + 1);
}

/** The step, in words. */
export function compactPhaseLabel(op: Pick<CompactOperation, 'mode' | 'phase' | 'error'>): string {
  switch (op.phase) {
    case 'started': return t('compact.phaseStarted');
    case 'summarizing': return t('compact.phaseSummarizing');
    case 'forking': return t('compact.phaseForking');
    case 'compacting': return t('compact.phaseCompacting');
    case 'done': return op.mode === 'native' ? t('compact.doneNative') : t('compact.doneFork');
    case 'error': return t('compact.failed', { error: op.error || t('compact.unknownError') });
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Tolerant reader of a daemon operation: a malformed one is dropped, not shown. */
export function readOperation(raw: unknown): CompactOperation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  const missionId = str(o.missionId);
  if (!id || !missionId) return null;
  if (o.mode !== 'native' && o.mode !== 'fork') return null;
  if (!PHASES.includes(o.phase as CompactPhase)) return null;
  const startedAt = typeof o.startedAt === 'number' ? o.startedAt : 0;
  return {
    id,
    missionId,
    mode: o.mode,
    phase: o.phase as CompactPhase,
    backend: str(o.backend) ?? '',
    model: str(o.model),
    targetMissionId: str(o.targetMissionId),
    error: str(o.error),
    startedAt,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : startedAt,
  };
}

/**
 * Folds a `compact_progress` event into the operation shown. An event of
 * another operation (started from another tab) replaces it; an older one
 * (the poll and the stream crossing) changes nothing.
 */
export function applyProgress(current: CompactOperation | null, raw: unknown): CompactOperation | null {
  if (!raw || typeof raw !== 'object') return current;
  const ev = raw as Record<string, unknown>;
  const operationId = str(ev.operationId);
  const missionId = str(ev.missionId);
  if (!operationId || !missionId) return current;
  if (ev.mode !== 'native' && ev.mode !== 'fork') return current;
  if (!PHASES.includes(ev.phase as CompactPhase)) return current;
  const at = typeof ev.at === 'number' ? ev.at : Date.now();
  const phase = ev.phase as CompactPhase;
  const mode: CompactMode = ev.mode;
  const patch = {
    phase,
    mode,
    targetMissionId: str(ev.targetMissionId),
    error: str(ev.error),
    updatedAt: at,
  };
  if (current && current.id === operationId) {
    if (at < current.updatedAt || isTerminalPhase(current.phase)) return current;
    return { ...current, ...patch, targetMissionId: patch.targetMissionId ?? current.targetMissionId };
  }
  if (current && current.missionId === missionId && at < current.startedAt) return current;
  return { id: operationId, missionId, backend: '', model: null, startedAt: at, ...patch };
}

/** The poll's answer against what is shown: the newest wins. */
function newer(current: CompactOperation | null, polled: CompactOperation | null): CompactOperation | null {
  if (!polled) return current;
  if (!current || polled.id !== current.id) return !current || polled.startedAt >= current.startedAt ? polled : current;
  if (isTerminalPhase(current.phase) || polled.updatedAt < current.updatedAt) return current;
  return polled;
}

/** A refusal of the start route, in words the user can act on. */
export function startFailure(status: number, body: unknown): string {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (b.code === 'turn_in_flight') return t('compact.turnInFlight');
  if (b.code === 'compact_in_progress') return t('compact.alreadyRunning');
  const error = str(b.error);
  return t('compact.failed', { error: error ?? `HTTP ${status}` });
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type CompactStoreDeps = {
  fetch: Fetch;
  /** Subscribes to `compact_progress`; returns the unsubscribe. */
  onProgress: (fn: (data: unknown) => void) => () => void;
  pollMs: number;
};

type Entry = {
  snapshot: CompactSnapshot;
  listeners: Set<() => void>;
  settled: Set<(s: CompactSettled) => void>;
  /** Operation this page started: only it navigates and toasts. */
  localOpId: string | null;
  loaded: boolean;
  poll: ReturnType<typeof setInterval> | null;
};

const IDLE: CompactSnapshot = { operation: null, starting: false, failure: null };

function route(missionId: string): string {
  return `/api/ui/missions/${encodeURIComponent(missionId)}/compact`;
}

export function createCompactStore(deps: CompactStoreDeps) {
  const entries = new Map<string, Entry>();
  let unsubscribeProgress: (() => void) | null = null;

  function entry(missionId: string): Entry {
    let e = entries.get(missionId);
    if (!e) {
      e = { snapshot: IDLE, listeners: new Set(), settled: new Set(), localOpId: null, loaded: false, poll: null };
      entries.set(missionId, e);
    }
    return e;
  }

  function set(missionId: string, patch: Partial<CompactSnapshot>): void {
    const e = entry(missionId);
    const before = e.snapshot.operation;
    const next = { ...e.snapshot, ...patch };
    if (next.operation === e.snapshot.operation && next.starting === e.snapshot.starting && next.failure === e.snapshot.failure) return;
    e.snapshot = next;
    const after = next.operation;
    // Settled = watched running, now ended. An operation found already over
    // (a reload, another tab) announces nothing: nobody here was waiting on it.
    if (after && isTerminalPhase(after.phase) && before && before.id === after.id && !isTerminalPhase(before.phase)) {
      const settled: CompactSettled = { operation: after, local: e.localOpId === after.id };
      for (const fn of [...e.settled]) fn(settled);
    }
    syncPoll(missionId);
    for (const fn of [...e.listeners]) fn();
  }

  function syncPoll(missionId: string): void {
    const e = entry(missionId);
    const want = e.listeners.size > 0 && isRunning(e.snapshot.operation);
    if (want && !e.poll) {
      e.poll = setInterval(() => { void load(missionId, true); }, deps.pollMs);
    } else if (!want && e.poll) {
      clearInterval(e.poll);
      e.poll = null;
    }
  }

  async function load(missionId: string, polling: boolean): Promise<void> {
    let res: Response;
    try {
      res = await deps.fetch(route(missionId), { cache: 'no-store' });
    } catch {
      return; // offline for a moment: the next tick asks again
    }
    if (!res.ok) {
      // The mission is gone or no longer ours: nothing left to follow.
      if (polling && (res.status === 404 || res.status === 403)) lose(missionId);
      return;
    }
    const body = await res.json().catch(() => null) as { operation?: unknown } | null;
    const polled = readOperation(body?.operation);
    const current = entry(missionId).snapshot.operation;
    if (!polled && polling && isRunning(current)) {
      lose(missionId);
      return;
    }
    set(missionId, { operation: newer(current, polled) });
  }

  /** The daemon no longer knows the running operation (it restarted): say so
   *  rather than keep a bar that would never end. */
  function lose(missionId: string): void {
    const current = entry(missionId).snapshot.operation;
    if (!current || !isRunning(current)) return;
    set(missionId, {
      operation: { ...current, phase: 'error', error: t('compact.lost'), updatedAt: Date.now() },
    });
  }

  function onProgress(data: unknown): void {
    const missionId = data && typeof data === 'object' ? str((data as Record<string, unknown>).missionId) : null;
    if (!missionId) return;
    const e = entries.get(missionId);
    if (!e) return;
    const next = applyProgress(e.snapshot.operation, data);
    if (next !== e.snapshot.operation) set(missionId, { operation: next });
  }

  function syncProgress(): void {
    const watched = [...entries.values()].some((e) => e.listeners.size > 0);
    if (watched && !unsubscribeProgress) unsubscribeProgress = deps.onProgress(onProgress);
    else if (!watched && unsubscribeProgress) {
      unsubscribeProgress();
      unsubscribeProgress = null;
    }
  }

  return {
    get(missionId: string | null): CompactSnapshot {
      return missionId ? entries.get(missionId)?.snapshot ?? IDLE : IDLE;
    },

    subscribe(missionId: string, fn: () => void): () => void {
      const e = entry(missionId);
      e.listeners.add(fn);
      syncProgress();
      if (!e.loaded) {
        e.loaded = true;
        void load(missionId, false);
      }
      syncPoll(missionId);
      return () => {
        e.listeners.delete(fn);
        syncPoll(missionId);
        syncProgress();
      };
    },

    onSettled(missionId: string, fn: (s: CompactSettled) => void): () => void {
      const e = entry(missionId);
      e.settled.add(fn);
      return () => { e.settled.delete(fn); };
    },

    async start(missionId: string, body: CompactRequest = {}): Promise<StartResult> {
      const e = entry(missionId);
      if (e.snapshot.starting || isRunning(e.snapshot.operation)) {
        return { ok: false, failure: t('compact.alreadyRunning') };
      }
      set(missionId, { starting: true, failure: null });
      let res: Response;
      try {
        res = await deps.fetch(route(missionId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const failure = t('compact.failed', { error: (err as Error).message || t('compact.unknownError') });
        set(missionId, { starting: false, failure });
        return { ok: false, failure };
      }
      const json = await res.json().catch(() => null) as { operation?: unknown; code?: unknown } | null;
      const operation = readOperation(json?.operation);
      // Already under way (another tab, a double click): follow that one.
      if (res.status === 409 && json?.code === 'compact_in_progress' && operation) {
        set(missionId, { starting: false, operation: newer(e.snapshot.operation, operation) });
        return { ok: true, operation };
      }
      if (!res.ok || !operation) {
        const failure = startFailure(res.status, json);
        set(missionId, { starting: false, failure });
        return { ok: false, failure };
      }
      e.localOpId = operation.id;
      // The stream may already have moved it on before the 202 came back.
      const current = e.snapshot.operation;
      set(missionId, {
        starting: false,
        operation: current && current.id === operation.id && current.updatedAt >= operation.updatedAt ? current : operation,
      });
      return { ok: true, operation };
    },

    /** Forgets a refusal shown in the panel. */
    clearFailure(missionId: string): void {
      set(missionId, { failure: null });
    },
  };
}

export type CompactStore = ReturnType<typeof createCompactStore>;

const POLL_MS = 4000;

export const compactStore: CompactStore = createCompactStore({
  fetch: (input, init) => fetch(input, init),
  onProgress: (fn) => sseOn('compact_progress', (event) => {
    try { fn(JSON.parse(String(event.data))); } catch { /* malformed frame */ }
  }),
  pollMs: POLL_MS,
});

/** The compaction of `missionId` as this page sees it. */
export function useMissionCompaction(missionId: string | null, store: CompactStore = compactStore): CompactSnapshot {
  // Stable per mission: a fresh subscribe on every render would drop the last
  // listener of the shared stream, closing and reopening it each time.
  const subscribe = useCallback(
    (fn: () => void) => (missionId ? store.subscribe(missionId, fn) : () => {}),
    [missionId, store],
  );
  return useSyncExternalStore(subscribe, () => store.get(missionId), () => IDLE);
}

/** Runs `fn` when an operation watched on this page ends. */
export function useCompactSettled(
  missionId: string | null,
  fn: (s: CompactSettled) => void,
  store: CompactStore = compactStore,
): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!missionId) return;
    return store.onSettled(missionId, (s) => latest.current(s));
  }, [missionId, store]);
}
