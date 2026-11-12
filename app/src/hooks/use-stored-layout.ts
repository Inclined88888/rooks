'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { toast } from 'sonner';
import { eraseLayout, loadLayout, saveLayout, storeLayout, type LayoutIo, type LayoutVersion } from '@/lib/ui-layout-store';
import { handoverKey, handoverOf, readHandover, type LayoutHandoverInput } from '@/lib/layout-handover';
import { useLayoutSeed } from '@/components/layout-seeds';
import { LAYOUT_RECALLED_EVENT } from '@/lib/layout-presets';

/**
 * Scoped opaque local SQLite state, guarded against late reads and navigation.
 * A scope still empty at its first read takes the value of its handover chain
 * (`lib/layout-handover.ts`) once: a shared legacy row is preserved, a row the
 * same arrangement was stored under before its scope changed is erased once
 * copied.
 *
 * The first render uses the value the server read for this scope, when there
 * is one (cf. `components/layout-seeds.tsx`). Without it, every consumer
 * painted its DEFAULTS until the network answered — the second of stock
 * canvas, stock cockpit and stock columns seen at every reload. A seed is only
 * ever a first paint: the read still happens, and still wins.
 *
 * It deliberately does NOT make the hook `ready`. Writing is what must wait
 * for a successful read: saving on top of a seed would let a value the server
 * merely believed to be current overwrite the stored one.
 *
 * `known` is the third state that reading needs and `ready` cannot give: has
 * this scope ANSWERED yet. `raw === null` means two different things — "not
 * read yet" and "read, nothing stored" — and a consumer that confuses them
 * paints its factory defaults while the answer is still on the wire.
 *
 * Every write is guarded by the version this instance read (`LayoutVersion`):
 * two windows on the same view — the desktop app and a browser tab — each hold
 * their own copy of the row, and without the guard the one left on an old
 * copy rewrote the whole row at its first gesture, erasing what the other had
 * added (an applied agent proposal included). A refused write re-reads the
 * row and REPLAYS the gestures it carried on top of it (`Pending`); the window
 * also re-reads when it comes back to the foreground, so that refusal stays
 * the exception.
 *
 * Replaying is why `update`'s `op` must be a pure function of its argument:
 * it runs again on a row this window never painted. An op that ignores its
 * argument (`() => value`) would, on replay, rewrite the other window's
 * arrangement with this window's old copy — the very loss the guard prevents.
 * Ids, clocks and toggles are decided before `update`, never inside `op`.
 */

/** A gesture painted but not yet confirmed by the daemon. */
type Entry = {
  op: (raw: unknown) => unknown;
  /** The value this gesture produced, the last time it was applied. */
  after: unknown;
  /** Drop it (and repaint without it) when its write fails. */
  undo: boolean;
};

/**
 * What one read of a scope still owes the daemon: the value the daemon is
 * known to hold (`base`) and the gestures painted over it since (`entries`,
 * oldest first). Shared by every copy of `current` made from that read, and
 * its identity is that read's: a scope change, a recall or an unmount leaves
 * it behind, and nothing is replayed onto a view that is gone.
 */
type Pending = {
  base: unknown;
  entries: Entry[];
  /** The re-read and replay under way after a refusal; the gestures made meanwhile wait for it. */
  rebasing: Promise<boolean> | null;
};

/** Re-reads in a row before giving up: a row rewritten that often is not worth chasing. */
const MAX_REBASES = 3;

function replay(pending: Pending): unknown {
  let raw = pending.base;
  for (const entry of pending.entries) {
    raw = entry.op(raw);
    entry.after = raw;
  }
  return raw;
}

/**
 * Values already read in this document, by scope.
 *
 * The server only seeds the route it rendered, and the widget host is mounted
 * by the root layout: it never remounts, so a client navigation lands on a
 * scope no seed describes and the read starts from zero — the second of stock
 * cards seen on every cockpit → chat → cockpit. What has been read once in
 * this document is still the answer when the view comes back, so it is served
 * as a seed and the network only confirms it.
 *
 * Cleared whenever a recall rewrites rows out of band, and when the account
 * changes: the account-less scopes (the canvas, the chat's skin) would
 * otherwise carry one user's arrangement into the next one's first paint.
 */
const remembered = new Map<string, unknown>();
/** Bumped with every clear: a read begun before it answers for a memory that no longer exists. */
let generation = 0;

export function forgetStoredLayouts(): void {
  remembered.clear();
  generation++;
}

/**
 * What this document already read (or wrote) for a scope, `undefined` when
 * nothing. For a consumer that cannot hand `useStoredLayout` its scope on the
 * first render yet — it still waits for another key — but must not paint its
 * defaults while the answer is already in memory.
 */
export function peekStoredLayout(scope: string | null): unknown {
  return scope ? remembered.get(scope) : undefined;
}

/**
 * Reads `scope` into this document's memory before the view that asks for it
 * is committed — a chat switch to another project (`preloadWorkspace`), which
 * would otherwise commit an empty board and paint it again once the read
 * lands. Like a server seed, a scope that holds nothing yet answers with its
 * pre-workspace value; the hook's own read still happens, and still migrates.
 * Never rejects: a failed read leaves the memory as it was.
 */
export async function preloadStoredLayout(scope: string, legacy?: LayoutHandoverInput): Promise<void> {
  if (remembered.has(scope)) return;
  // A logout, an account switch or a recall in the meantime: the answer is the
  // previous account's row (or the pre-recall one), not this memory's.
  const started = generation;
  const own = await loadLayout({ scope, storage: null });
  if (!own.ok) return;
  let raw = own.raw;
  // Read only: the copy, and the erasure of a consumed source, belong to the
  // hook's first read. Erasing here would lose the row before it was copied.
  if (raw === null) {
    const old = await readHandover(handoverOf(legacy), (source) => loadLayout({ scope: source, storage: null }));
    if (!old.ok) return;
    raw = old.raw;
  }
  if (started !== generation) return;
  // A mounted hook may have read (or written) the scope meanwhile: its value is newer.
  if (!remembered.has(scope)) remembered.set(scope, raw);
}

export function useStoredLayout(scope: string | null, legacy?: LayoutHandoverInput, { cancelQueuedOnUnmount = false }: { cancelQueuedOnUnmount?: boolean } = {}) {
  const seed = useLayoutSeed(scope);
  const [state, setState] = useState<{ scope: string; raw: unknown } | null>(null);
  const current = useRef<{ scope: string; raw: unknown; ready: boolean; version: LayoutVersion; pending: Pending } | null>(null);
  // Bumped by a recall, which writes the rows of a whole view out of band (a
  // preset covers scopes whose owner is not even mounted). Re-reading here
  // rather than in each consumer is what lets a plugin's own scope follow a
  // preset without knowing presets exist. Cf. `docs/LAYOUT-PRESETS.md`.
  const [recall, setRecall] = useState(0);
  // Scopes this instance has already read successfully. The legacy handover
  // belongs to the FIRST read of a scope, not to "before any recall happened":
  // a recall may have erased a scope on purpose, and re-seeding it from the
  // pre-scope value would resurrect the arrangement the click meant to clear —
  // while a scope visited for the first time afterwards (the chat's columns,
  // opened after a cockpit preset was recalled) must still migrate.
  const read = useRef(new Set<string>());
  // Callers build their chain at every render: the read follows its identity,
  // not the array's.
  const chainKey = handoverKey(legacy);
  const chain = useRef(handoverOf(legacy));
  chain.current = handoverOf(legacy);
  useEffect(() => {
    const onRecalled = () => { forgetStoredLayouts(); setRecall((n) => n + 1); };
    window.addEventListener(LAYOUT_RECALLED_EVENT, onRecalled);
    return () => window.removeEventListener(LAYOUT_RECALLED_EVENT, onRecalled);
  }, []);
  useEffect(() => {
    current.current = null;
    if (!scope) return;
    let alive = true;
    void (async () => {
      let out = await loadLayout({ scope, storage: null });
      if (!alive) return;
      const sources = chain.current;
      if (out.ok && out.raw === null && sources.length > 0 && !read.current.has(scope)) {
        const old = await readHandover(sources, (source) => loadLayout({ scope: source, storage: null }));
        if (!alive) return;
        if (!old.ok) out = { raw: null, ok: false, migrated: false };
        else if (old.from) {
          // The version of the row this write produced is not known here: the
          // first gesture goes unguarded rather than refused.
          const saved = await saveLayout(old.raw, { scope, storage: null });
          out = { raw: old.raw, ok: saved, migrated: false, updatedAt: undefined };
          // Erased only once the new row holds it: a refused write loses nothing.
          if (saved && old.from.consumed) void eraseLayout({ scope: old.from.scope, storage: null });
        }
      }
      if (!alive) return;
      if (out.ok) { read.current.add(scope); remembered.set(scope, out.raw); }
      // A box per read: writes still queued from the previous one keep theirs,
      // and stay refused if they were stale.
      current.current = {
        scope, raw: out.raw, ready: out.ok, version: { value: out.ok ? out.updatedAt : undefined },
        pending: { base: out.raw, entries: [], rebasing: null },
      };
      setState({ scope, raw: out.raw });
    })();
    return () => { alive = false; current.current = null; };
  }, [scope, chainKey, recall]);
  // Coming back to a window is when another one may have rewritten the row:
  // re-reading then shows it before the next gesture, instead of letting that
  // gesture be refused.
  useEffect(() => {
    if (!scope) return;
    let alive = true;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      const seen = current.current;
      if (!seen || seen.scope !== scope || !seen.ready || seen.version.value === undefined || seen.pending.rebasing) return;
      void loadLayout({ scope, storage: null }).then((out) => {
        // A gesture made meanwhile wins: its own write is guarded.
        if (!alive || current.current !== seen || seen.pending.rebasing || !out.ok || out.updatedAt === undefined) return;
        if (out.updatedAt === seen.version.value) return;
        // Gestures not written yet (a failed save, a drag still under way)
        // stay on screen, over the newer row; the next write carries them.
        seen.pending.base = out.raw;
        const raw = replay(seen.pending);
        remembered.set(scope, raw);
        current.current = { ...seen, raw, ready: true, version: { value: out.updatedAt } };
        setState({ scope, raw });
      });
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [scope]);

  const ioFor = useCallback((scope: string, version: LayoutVersion): LayoutIo => ({
    scope, storage: null, version,
    // A queued write must not start with a new account's session cookie
    // after this owner/view has unmounted. A rejection, not a fake status:
    // a 409 would read as another window's write.
    fetchImpl: (input, init) => !cancelQueuedOnUnmount || current.current?.scope === scope
      ? fetch(input, init)
      : Promise.reject(new Error('layout owner unmounted')),
  }), [cancelQueuedOnUnmount]);

  /**
   * Writes what the screen shows, on behalf of `entry` (the newest gesture it
   * includes). `null` is what this hook reads as "nothing stored", and the
   * daemon refuses to store it (400): `storeLayout` erases the row instead, on
   * the same per-scope chain as the saves.
   */
  const send = useCallback((scope: string, pending: Pending, entry: Entry, attempt: number): Promise<boolean> => {
    const value = current.current;
    if (value?.scope !== scope || value.pending !== pending) return Promise.resolve(false);
    const version = value.version;
    return storeLayout(value.raw, ioFor(scope, version)).then((result): boolean | Promise<boolean> => {
      if (result === 'ok') {
        // Everything up to this gesture is now the daemon's.
        const index = pending.entries.indexOf(entry);
        if (index >= 0) {
          pending.base = entry.after;
          pending.entries.splice(0, index + 1);
        }
        return true;
      }
      if (result === 'conflict') return rebaseRef.current(scope, pending, version, attempt);
      // A refused write is not what the scope holds: remembering it would
      // repaint, on the way back, the very gesture that did not land.
      remembered.delete(scope);
      toast.error(t('widgets.saveError'), { id: 'layout-save' });
      const now = current.current;
      const index = pending.entries.indexOf(entry);
      if (entry.undo && index >= 0 && now?.pending === pending) {
        pending.entries.splice(index, 1);
        const raw = replay(pending);
        current.current = { ...now, raw };
        setState({ scope, raw });
      }
      return false;
    });
  }, [ioFor]);

  /**
   * Another window wrote the row since this one read it. Its arrangement is
   * read again, and the gestures this window had not got written yet are
   * replayed on top of it, then written — guarded by the new version. Once
   * per read: the writes queued behind the refused one carry the same stale
   * version, and wait for this replay instead of starting their own.
   */
  const rebase = useCallback((scope: string, pending: Pending, version: LayoutVersion, attempt: number): Promise<boolean> => {
    const now = current.current;
    if (now?.scope !== scope || now.pending !== pending) return Promise.resolve(false);
    if (pending.rebasing) return pending.rebasing;
    const last = pending.entries[pending.entries.length - 1];
    // Already replayed onto a newer read (a focus re-read): only the write is left.
    if (now.version !== version) return last ? send(scope, pending, last, attempt) : Promise.resolve(true);
    const giveUp = (): false => {
      remembered.delete(scope);
      const back = current.current;
      if (back?.pending === pending && back.ready) {
        current.current = { ...back, ready: false };
        toast.info(t('widgets.changedElsewhere'), { id: 'layout-conflict' });
        setRecall((n) => n + 1);
      }
      return false;
    };
    if (attempt >= MAX_REBASES) return Promise.resolve(giveUp());
    const run = (async (): Promise<boolean> => {
      // Waits for the stale writes still queued on this scope: they are
      // refused too, and this replay answers for them.
      const out = await loadLayout({ scope, storage: null });
      const back = current.current;
      pending.rebasing = null;
      if (back?.scope !== scope || back.pending !== pending) return false;
      if (!out.ok || out.updatedAt === undefined) return giveUp();
      pending.base = out.raw;
      const raw = replay(pending);
      remembered.set(scope, raw);
      current.current = { ...back, raw, version: { value: out.updatedAt } };
      setState({ scope, raw });
      const newest = pending.entries[pending.entries.length - 1];
      const landed = newest ? await send(scope, pending, newest, attempt + 1) : true;
      if (landed && attempt === 0) toast.info(t('widgets.replayedElsewhere'), { id: 'layout-conflict' });
      return landed;
    })();
    pending.rebasing = run;
    return run;
  }, [send]);
  // `send` and `rebase` call each other: one of them goes through a ref.
  const rebaseRef = useRef(rebase);
  rebaseRef.current = rebase;

  const update = useCallback((
    op: (raw: unknown) => unknown,
    persist = true,
    { undoOnFailure = false }: { undoOnFailure?: boolean } = {},
  ) => {
    const value = current.current;
    if (!scope || value?.scope !== scope || !value.ready) return Promise.resolve(false);
    const raw = op(value.raw);
    const entry: Entry = { op, after: raw, undo: undoOnFailure };
    value.pending.entries.push(entry);
    current.current = { ...value, raw };
    // What the view shows is what it must show again on the way back: without
    // this, leaving right after a drag and returning would paint the placement
    // as it was BEFORE the gesture, until the read lands.
    remembered.set(scope, raw);
    setState({ scope, raw });
    if (!persist) return Promise.resolve(true);
    // A replay under way writes this gesture with the others.
    if (value.pending.rebasing) return value.pending.rebasing;
    return send(scope, value.pending, entry, 0);
  }, [scope, send]);
  // The seed speaks only until the read lands, and only for the scope it was
  // fetched under — `useLayoutSeed` already keys on it, so a navigation that
  // changes the scope falls back to `null` instead of repainting the previous
  // view's value.
  const loaded = state?.scope === scope;
  // A seed, then what this document already read for this scope: both describe
  // the stored value, neither is a default.
  const hasSeed = seed !== undefined;
  const hasMemory = !!scope && !hasSeed && remembered.has(scope);
  return {
    raw: loaded ? state!.raw : hasSeed ? seed : hasMemory ? remembered.get(scope!) : null,
    update,
    ready: !!scope && current.current?.scope === scope && current.current.ready,
    // `loaded` and not `ready`: a read the daemon refused has answered all the
    // same, and leaving the consumer on an empty board forever — one it could
    // not even edit, `update` being gated on `ready` — would be worse than the
    // defaults it used to show.
    known: loaded || hasSeed || hasMemory,
  };
}
