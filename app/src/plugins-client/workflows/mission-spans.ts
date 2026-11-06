/**
 * Paged, incrementally refreshed timeline of one mission (#215).
 *
 * A mission can hold hundreds of thousands of spans. The timeline used to
 * download all of them, payloads included, on every event and on every
 * mount. It now holds a window: the latest page first, older pages on demand,
 * and a refresh that asks for the delta only — whatever came after the last
 * span it holds, plus the spans it holds as `running` (a turn span stays open
 * for the whole turn, far behind the tail, so a cursor alone never sees it
 * close). Loaded windows are kept per mission, so reopening a card shows its
 * list at once and fetches the delta.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { sseOn } from '@/lib/sse-stream';
import type { TraceSpan } from './types';

export const SPAN_PAGE_SIZE = 100;
const MAX_CATCH_UP_PAGES = 5;
const MAX_RUNNING_IDS = 50;
const CACHE_LIMIT = 6;
const REFRESH_DEBOUNCE_MS = 800;

/** `pruned`: spans of this mission that retention removed, rebuildable from its events. */
export type MissionSpansState = { spans: TraceSpan[]; total: number; hasOlder: boolean; pruned: number };
type SpanPage = { spans: TraceSpan[]; total: number; has_more: boolean; pruned: number };

/** `seq.rowid`, both integers — see `SPAN_CURSOR_PATTERN` on the daemon. */
export function compareCursor(left: string, right: string): number {
  const [leftSeq = 0, leftRid = 0] = left.split('.').map(Number);
  const [rightSeq = 0, rightRid = 0] = right.split('.').map(Number);
  return leftSeq - rightSeq || leftRid - rightRid;
}

function sameSpan(left: TraceSpan, right: TraceSpan): boolean {
  return left.status === right.status && left.ended_at === right.ended_at && left.duration_ms === right.duration_ms
    && left.tokens_in === right.tokens_in && left.tokens_out === right.tokens_out && left.cost_usd === right.cost_usd
    && left.name === right.name;
}

/** Merge by id, keeping the identity of every span that did not change and
 *  returning `current` itself when nothing did, so React skips the render. */
export function mergeSpans(current: TraceSpan[], incoming: TraceSpan[]): TraceSpan[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((span) => [span.id, span]));
  let changed = false;
  for (const span of incoming) {
    const held = byId.get(span.id);
    if (held && sameSpan(held, span)) continue;
    byId.set(span.id, span);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => compareCursor(a.cursor ?? '0.0', b.cursor ?? '0.0'));
}

async function fetchSpanPage(missionId: string, params: Record<string, string | number>): Promise<SpanPage | null> {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  try {
    const response = await fetch(`/api/ui/missions/${encodeURIComponent(missionId)}/spans?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const value = await response.json() as Partial<SpanPage>;
    return { spans: value.spans ?? [], total: value.total ?? 0, has_more: Boolean(value.has_more), pruned: value.pruned ?? 0 };
  } catch {
    return null;
  }
}

export async function loadLatestSpans(missionId: string): Promise<MissionSpansState | null> {
  const page = await fetchSpanPage(missionId, { limit: SPAN_PAGE_SIZE });
  return page ? { spans: page.spans, total: page.total, hasOlder: page.has_more, pruned: page.pruned } : null;
}

/** Asks the daemon to replay this mission's events into its timeline. */
export async function rebuildSpans(missionId: string): Promise<boolean> {
  const response = await fetch(`/api/ui/missions/${encodeURIComponent(missionId)}/spans/rebuild`, { method: 'POST', cache: 'no-store' }).catch(() => null);
  return response?.ok ?? false;
}

export async function loadOlderSpans(missionId: string, oldestCursor: string): Promise<SpanPage | null> {
  return fetchSpanPage(missionId, { limit: SPAN_PAGE_SIZE, before: oldestCursor });
}

/** What a refresh learned: spans to merge in, or `reset` when the window fell
 *  too far behind the mission to be patched. `null` = the daemon did not answer. */
export type SpanDelta = { incoming: TraceSpan[]; total: number } | 'reset' | null;

export async function loadSpanDelta(missionId: string, held: TraceSpan[]): Promise<SpanDelta> {
  const last = held.at(-1)?.cursor;
  if (!last) return 'reset';
  const incoming: TraceSpan[] = [];
  let total = 0;
  let from = last;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_CATCH_UP_PAGES) return 'reset';
    const result = await fetchSpanPage(missionId, { limit: SPAN_PAGE_SIZE, from });
    if (!result) return null;
    incoming.push(...result.spans);
    total = result.total;
    const next = result.spans.at(-1)?.cursor;
    if (!result.has_more || !next) break;
    from = next;
  }
  const running = held.filter((span) => span.status === 'running').slice(0, MAX_RUNNING_IDS);
  if (running.length > 0) {
    const reread = await fetchSpanPage(missionId, { ids: running.map((span) => span.id).join(',') });
    if (reread) incoming.push(...reread.spans);
  }
  return { incoming, total };
}

const cache = new Map<string, MissionSpansState>();
function cacheGet(missionId: string | null): MissionSpansState | null {
  if (!missionId) return null;
  const held = cache.get(missionId);
  if (!held) return null;
  cache.delete(missionId);
  cache.set(missionId, held);
  return held;
}
function cachePut(missionId: string, state: MissionSpansState): void {
  cache.delete(missionId);
  cache.set(missionId, state);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}
/** For tests: forget every loaded window. */
export function clearSpanCache(): void { cache.clear(); }

export function useMissionSpans(missionId: string | null, live: boolean) {
  const [held, setHeld] = useState<{ id: string; state: MissionSpansState } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState(false);
  const stateRef = useRef<MissionSpansState | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | null>(null);

  const commit = useCallback((id: string, next: MissionSpansState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    cachePut(id, next);
    setHeld({ id, state: next });
  }, []);

  const refresh = useCallback(async () => {
    if (!missionId) return;
    if (busy.current) { again.current = true; return; }
    const mine = generation.current;
    busy.current = true;
    try {
      do {
        again.current = false;
        const current = stateRef.current;
        if (!current) {
          const latest = await loadLatestSpans(missionId);
          if (mine !== generation.current) return;
          if (latest) { commit(missionId, latest); setFailed(false); } else setFailed(true);
          continue;
        }
        const delta = await loadSpanDelta(missionId, current.spans);
        if (mine !== generation.current) return;
        if (delta === null) continue;
        if (delta === 'reset') {
          const latest = await loadLatestSpans(missionId);
          if (mine !== generation.current) return;
          if (latest) commit(missionId, latest);
          continue;
        }
        // Merge onto the state as it is NOW: an older page may have landed meanwhile.
        const now = stateRef.current ?? current;
        const spans = mergeSpans(now.spans, delta.incoming);
        if (spans !== now.spans || delta.total !== now.total) commit(missionId, { ...now, spans, total: delta.total });
      } while (again.current);
    } finally {
      if (mine === generation.current) busy.current = false;
    }
  }, [missionId, commit]);

  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    again.current = false;
    const cached = cacheGet(missionId);
    stateRef.current = cached;
    setHeld(cached && missionId ? { id: missionId, state: cached } : null);
    setLoadingOlder(false);
    setFailed(false);
    void refresh();
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [missionId, refresh]);

  useEffect(() => {
    if (!live || !missionId) return undefined;
    const schedule = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { void refresh(); }, REFRESH_DEBOUNCE_MS);
    };
    const off = sseOn('event', (event) => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        if ((JSON.parse(event.data) as { missionId?: string }).missionId !== missionId) return;
      } catch { return; }
      schedule();
    });
    // Events are ignored while the tab is hidden; the delta is cheap, so catch up once it shows again.
    const onVisible = () => { if (!document.hidden) schedule(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); };
  }, [live, missionId, refresh]);

  const loadOlder = useCallback(async () => {
    const current = stateRef.current;
    const oldest = current?.spans[0]?.cursor;
    if (!missionId || !current || !current.hasOlder || !oldest) return;
    const mine = generation.current;
    setLoadingOlder(true);
    const page = await loadOlderSpans(missionId, oldest);
    if (mine !== generation.current) return;
    setLoadingOlder(false);
    if (!page) return;
    const now = stateRef.current ?? current;
    commit(missionId, { spans: mergeSpans(now.spans, page.spans), total: page.total, hasOlder: page.has_more, pruned: page.pruned });
  }, [missionId, commit]);

  const rebuild = useCallback(async () => {
    if (!missionId || !await rebuildSpans(missionId)) return false;
    // The delta starts from the spans held, and there are none: this re-reads the latest page.
    await refresh();
    return true;
  }, [missionId, refresh]);

  const state = held && held.id === missionId ? held.state : null;
  return { spans: state?.spans ?? null, total: state?.total ?? 0, hasOlder: state?.hasOlder ?? false, pruned: state?.pruned ?? 0, loadingOlder, loadOlder, failed, rebuild };
}
