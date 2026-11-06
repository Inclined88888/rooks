/**
 * Widget placement, stored by the daemon.
 *
 * Until now the placement lived in `localStorage`: one layout per browser, lost
 * when changing machine, and absent from `timon export`. The daemon is now the
 * source of truth; the browser only keeps what it had before the switch, long
 * enough to hand it over.
 *
 * The layout itself stays opaque here: this module moves a JSON value between
 * the browser and `/api/ui/layout`, it never reads inside it. Reconciling that
 * value with the widget registry is `cockpit-layout.ts`'s job.
 */

import { machineLocalStorage } from '@/lib/machines/machine-storage';

export const LAYOUT_ENDPOINT = '/api/ui/layout';

/** Key the placement used to be written under, before it moved to the daemon.
 *  Read once, at migration time, then removed. */
export const LEGACY_LAYOUT_KEY = 'timon.cockpit.layout';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;

/**
 * The version of a row a writer last saw (`updatedAt` of the daemon), held in
 * a box its writes share. A write carrying one is conditional: the daemon
 * refuses it (409) once the row moved since — another window wrote it. Each
 * successful write moves the box to the version it produced, so a drag's
 * writes chain on one another; it is read when the request leaves, not when
 * it is queued. `null` = "nothing was stored", `undefined` = no guard (an
 * older daemon that does not report versions).
 */
export type LayoutVersion = { value: number | null | undefined };

/** How a write went. `conflict` only ever answers a guarded write. */
export type LayoutWrite = 'ok' | 'conflict' | 'failed';

export type LayoutIo = {
  scope?: string;
  version?: LayoutVersion;
  fetchImpl?: FetchLike;
  /** `null` disables the migration entirely (server rendering, or a browser
   *  that refuses storage). */
  storage?: LegacyStorage | null;
};

export type LoadedLayout = {
  /** The stored value, or `null` when nothing is stored yet. */
  raw: unknown;
  /** `false` when the daemon could not be reached. The caller must then avoid
   *  saving: writing a default layout over a placement we failed to read would
   *  destroy it on the first drag. */
  ok: boolean;
  /** `true` when a pre-existing browser layout was handed over during this
   *  call. Reported for the tests and the logs; the caller has nothing to do
   *  with it. */
  migrated: boolean;
  /** The version read, to guard the writes made from this value. `undefined`
   *  when unknown: a failed read, a daemon that does not report it, or a value
   *  this call wrote itself during the migration. */
  updatedAt?: number | null;
};

function url(scope: string | undefined, expected?: number | null): string {
  const query: string[] = [];
  if (scope) query.push(`scope=${encodeURIComponent(scope)}`);
  if (expected !== undefined) query.push(`expected=${expected === null ? 'none' : expected}`);
  return query.length ? `${LAYOUT_ENDPOINT}?${query.join('&')}` : LAYOUT_ENDPOINT;
}

function readVersion(raw: unknown): number | null | undefined {
  return typeof raw === 'number' || raw === null ? raw : undefined;
}

/** An unknown version is left out rather than spelled `undefined`. */
function known(updatedAt: number | null | undefined): { updatedAt?: number | null } {
  return updatedAt === undefined ? {} : { updatedAt };
}

function defaultStorage(): LegacyStorage | null {
  try {
    // Only the local machine has a layout from before the daemon kept it:
    // another machine's prefix holds none, so nothing is handed to the wrong daemon.
    return machineLocalStorage();
  } catch {
    // Private mode or a blocked origin: no legacy layout to hand over.
    return null;
  }
}

/** The layout left behind in the browser, or `null` if there is none to hand
 *  over. Unreadable storage is treated as empty rather than fatal. */
function readLegacy(storage: LegacyStorage): unknown {
  try {
    const raw = storage.getItem(LEGACY_LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Queued value meaning "forget this scope". A sentinel and not `null`: the
 *  daemon refuses to store `null`, so "nothing" has to be asked for as an
 *  erasure (`useStoredLayout.update` maps its `null` here). */
const ERASE = Symbol('erase-layout');

async function put(io: LayoutIo, layout: unknown): Promise<LayoutWrite> {
  const doFetch = io.fetchImpl ?? fetch;
  const expected = io.version?.value;
  try {
    const res = layout === ERASE
      ? await doFetch(url(io.scope, expected), { method: 'DELETE' })
      : await doFetch(url(io.scope, expected), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout }),
      });
    if (expected !== undefined && res.status === 409) return 'conflict';
    if (!res.ok) return 'failed';
    if (io.version) {
      const body = (await res.json().catch(() => null)) as { updatedAt?: unknown } | null;
      io.version.value = readVersion(body?.updatedAt);
    }
    return 'ok';
  } catch {
    return 'failed';
  }
}

/** A layout waiting for its turn, and the callers it answers. */
type Queued = { layout: unknown; io: LayoutIo; waiting: Array<(result: LayoutWrite) => void> };

/** One write chain per scope: the request on the wire, plus the layouts
 *  waiting for their turn. */
type Chain = {
  sending: boolean;
  queue: Queued[];
  idle: Array<() => void>;
};

const chains = new Map<string, Chain>();

/** Sends the queued layouts one at a time until none is left. Every caller
 *  coalesced into a write is told how that write went. */
async function drain(key: string, chain: Chain): Promise<void> {
  chain.sending = true;
  try {
    for (let next = chain.queue.shift(); next; next = chain.queue.shift()) {
      const result = await put(next.io, next.layout);
      for (const resolve of next.waiting) resolve(result);
    }
  } finally {
    chain.sending = false;
    for (const resolve of chain.idle) resolve();
    // Nothing queued: the scope leaves no trace behind.
    if (chain.queue.length === 0) chains.delete(key);
  }
}

/**
 * Reads the layout from the daemon and, the very first time, hands over the one
 * the browser was still holding.
 *
 * The migration runs at most once because it *consumes* its source: the legacy
 * key is removed only after the daemon acknowledged the write. A daemon that is
 * down therefore loses nothing — the key stays, and the next load tries again.
 */
export async function loadLayout(io: LayoutIo = {}): Promise<LoadedLayout> {
  // Returning to a view immediately after a drop must observe that drop,
  // including any coalesced write still waiting for the previous request.
  const pending = chains.get(io.scope ?? '');
  if (pending) await new Promise<void>((resolve) => pending.idle.push(resolve));
  const doFetch = io.fetchImpl ?? fetch;
  let stored: unknown = null;
  let updatedAt: number | null | undefined;
  try {
    const res = await doFetch(url(io.scope), { cache: 'no-store' });
    if (!res.ok) return { raw: null, ok: false, migrated: false };
    const body = (await res.json()) as { layout: unknown; updatedAt?: unknown };
    stored = body.layout ?? null;
    updatedAt = readVersion(body.updatedAt);
  } catch {
    return { raw: null, ok: false, migrated: false };
  }

  const storage = io.storage === undefined ? defaultStorage() : io.storage;
  if (stored !== null || !storage) return { raw: stored, ok: true, migrated: false, ...known(updatedAt) };

  // The daemon knows nothing yet: this browser's layout is the only one there
  // is, so it becomes the shared one.
  const legacy = readLegacy(storage);
  if (legacy === null) return { raw: null, ok: true, migrated: false, ...known(updatedAt) };
  if (!(await saveLayout(legacy, io))) return { raw: legacy, ok: true, migrated: false };
  try {
    storage.removeItem(LEGACY_LAYOUT_KEY);
  } catch {
    // Removal refused: the next load will simply find the daemon already
    // served, and will not migrate again.
  }
  return { raw: legacy, ok: true, migrated: true };
}

/**
 * Persists a layout. Returns `false` on a daemon that did not take it, so the
 * caller can decide whether it matters — a placement is not worth an alert.
 *
 * Writes are serialised per scope. A drag emits one save per drop, and two
 * requests left in flight together can reach the daemon in either order: the
 * older placement would then be the one stored, and it would come back at the
 * next load. Holding a single request at a time makes the last layout asked for
 * the last one written. Saves piling up behind the in-flight request are
 * coalesced, since only the newest of them describes the board on screen.
 */
export function saveLayout(layout: unknown, io: LayoutIo = {}): Promise<boolean> {
  return writeLayout(layout, io).then((result) => result === 'ok');
}

/**
 * `saveLayout`, telling a refused guarded write (`conflict`) from a failure.
 * `null` erases the scope — `useStoredLayout` reads both as "nothing stored".
 */
export function storeLayout(layout: unknown, io: LayoutIo = {}): Promise<LayoutWrite> {
  return writeLayout(layout === null ? ERASE : layout, io);
}

function writeLayout(layout: unknown, io: LayoutIo): Promise<LayoutWrite> {
  const key = io.scope ?? '';
  const chain = chains.get(key) ?? { sending: false, queue: [], idle: [] };
  chains.set(key, chain);
  // Replaces the layout still queued by the same writer: it never made it to
  // the wire and is already stale; its caller waits for this newer write
  // instead. Two writers guarding different reads are never merged — one
  // could then be told of the other's refusal, or slip through on its guard.
  const last = chain.queue[chain.queue.length - 1];
  const settled = new Promise<LayoutWrite>((resolve) => {
    if (last && last.io.version === io.version) {
      last.layout = layout;
      last.io = io;
      last.waiting.push(resolve);
    } else {
      chain.queue.push({ layout, io, waiting: [resolve] });
    }
  });
  if (!chain.sending) void drain(key, chain);
  return settled;
}

/**
 * Every stored layout of a family, in one round trip.
 *
 * A workspace spreads its arrangement over several scopes, and which ones is
 * not knowable from the browser: a plugin opens its own the day it is
 * installed. Asking the daemon for the whole prefix is what makes a preset a
 * photograph of the view rather than of a list of suffixes someone has to
 * keep up to date (`docs/LAYOUT-PRESETS.md`).
 *
 * Waits on the pending writes of every scope under the prefix, for the same
 * reason `loadLayout` does: photographing a view right after a drop must
 * include that drop.
 */
export async function listLayouts(
  prefix: string,
  io: Omit<LayoutIo, 'scope'> = {},
): Promise<{ rows: { scope: string; layout: unknown }[]; ok: boolean }> {
  const idle = [...chains.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, chain]) => new Promise<void>((resolve) => chain.idle.push(resolve)));
  if (idle.length) await Promise.all(idle);
  const doFetch = io.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${LAYOUT_ENDPOINT}?prefix=${encodeURIComponent(prefix)}`, { cache: 'no-store' });
    if (!res.ok) return { rows: [], ok: false };
    const body = (await res.json()) as { layouts?: { scope: string; layout: unknown }[] };
    return { rows: body.layouts ?? [], ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

/**
 * Forgets a scope, so a consumer falls back to its defaults.
 *
 * Goes through the same per-scope chain as a save: an erasure racing a queued
 * write would otherwise be undone by it, and the row a recall meant to clear
 * would come back at the next load.
 */
export function eraseLayout(io: LayoutIo = {}): Promise<boolean> {
  return storeLayout(null, io).then((result) => result === 'ok');
}
