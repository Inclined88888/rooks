/**
 * The last answer per page, kept in memory (docs/design/0003-workroom.md, section 6, principle 4): a page you come
 * back to shows what it showed last time at once and asks again in the background. Nothing is written to disk; a
 * reload starts empty. Two parts asking for the same key at once share one request.
 *
 *   const { data, error, refresh, mutate } = useCached("tasks", () => api<Task[]>("/tasks"));
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Entry = { data: unknown; at: number };

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const MAX = 64;

/** The last answer for this key, if any. */
export function peekCached<T>(key: string): T | undefined {
  return memory.get(key)?.data as T | undefined;
}

/** Keep an answer for this key (the newest MAX keys stay). */
export function putCached<T>(key: string, data: T): void {
  memory.delete(key);
  memory.set(key, { data, at: Date.now() });
  if (memory.size > MAX) memory.delete(memory.keys().next().value as string);
}

/** Ask once for this key, however many parts ask at the same time; the answer is kept. */
export function loadCached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = loader().then((d) => { putCached(key, d); return d; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** For tests and sign out. */
export function clearCached(): void {
  memory.clear();
  inflight.clear();
}

export type Cached<T> = {
  /** The newest answer: the kept one at first, then the fresh one. */
  data: T | undefined;
  /** The last ask failed (data may still hold the kept answer). */
  error: unknown;
  /** True until the first answer of this visit arrives (the kept one shows meanwhile). */
  refreshing: boolean;
  refresh: () => Promise<void>;
  /** Change what is shown (and kept) without asking, after the page itself changed it. */
  mutate: (next: T | ((cur: T | undefined) => T)) => void;
};

export function useCached<T>(key: string | null, loader: () => Promise<T>): Cached<T> {
  const [data, setData] = useState<T | undefined>(() => (key ? peekCached<T>(key) : undefined));
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(async () => {
    const k = keyRef.current;
    if (!k) return;
    try {
      const d = await loadCached(k, () => loaderRef.current());
      if (keyRef.current === k) { setData(d); setError(null); }
    } catch (e) {
      if (keyRef.current === k) setError(e);
    } finally {
      if (keyRef.current === k) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setData(key ? peekCached<T>(key) : undefined);
    setRefreshing(true);
    void refresh();
  }, [key, refresh]);

  const mutate = useCallback((next: T | ((cur: T | undefined) => T)) => {
    setData((cur) => {
      const v = typeof next === "function" ? (next as (c: T | undefined) => T)(cur) : next;
      if (keyRef.current) putCached(keyRef.current, v);
      return v;
    });
  }, []);

  return { data, error, refreshing, refresh, mutate };
}
