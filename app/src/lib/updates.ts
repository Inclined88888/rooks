/**
 * The "new version" offer of `@rooks/updates`, as the browser sees it
 * (`GET /api/ui/updates`, docs/AUTO-UPDATE.md §6).
 *
 * One store for the whole page: the banner host and the build-expiry banner
 * both read it, so the update banner can take the expiry notice's place
 * without a second request. The daemon has already verified the signed
 * manifest; nothing here judges trust, it only picks which installer to link.
 */
import { useSyncExternalStore } from 'react';
import { sseOn } from './sse-stream';
import { machineScopedStorage } from './machines/machine-storage';

export const UPDATES_URL = '/api/ui/updates';
export const UPDATES_CHECK_URL = '/api/ui/updates/check';
export const UPDATES_MODULE = '@rooks/updates';

export type UpdateOs = 'linux' | 'mac' | 'win';

export type UpdateArtifact = {
  key: string;
  os: UpdateOs;
  arch: 'x64' | 'arm64' | 'universal';
  format: 'appimage' | 'deb' | 'pkg' | 'dmg' | 'nsis';
  name: string;
  url: string;
  size: number;
};

export type UpdateOffer = {
  version: string;
  publishedAt: string;
  /** Plain text: shown as text, never as HTML. */
  notes: string;
  notesUrl: string;
  artifacts: UpdateArtifact[];
};

export type UpdateStatus = {
  installed: string;
  channel: 'beta' | 'stable' | 'dev';
  enabled: boolean;
  state: 'off' | 'dev' | 'unchecked' | 'up_to_date' | 'available' | 'failed';
  checkedAt: string | null;
  available: UpdateOffer | null;
  host: { os: UpdateOs | null; arch: string };
  buildExpiresAt: string | null;
};

/** Installer formats in the order a person would pick them on each system. */
const FORMAT_ORDER: Record<UpdateOs, readonly UpdateArtifact['format'][]> = {
  linux: ['appimage', 'deb'],
  // The `.pkg` installs the command line and the service; the `.dmg` does not.
  mac: ['pkg', 'dmg'],
  win: ['nsis'],
};

/** The system of the browser, or `null` for a phone, a tablet or anything unknown. */
export function clientOs(userAgent: string): UpdateOs | null {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return null;
  if (/Windows/i.test(userAgent)) return 'win';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac';
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux';
  return null;
}

/**
 * The installers offered to this browser, the one to download first. On the
 * daemon's own system the daemon's architecture wins (the desktop app and its
 * daemon share a machine); elsewhere a universal build, then x64.
 */
export function installersFor(offer: UpdateOffer, os: UpdateOs | null, host: UpdateStatus['host']): UpdateArtifact[] {
  if (!os) return [];
  const archOrder = [...(host.os === os ? [host.arch] : []), 'universal', 'x64', 'arm64'];
  const rank = (artifact: UpdateArtifact): number => {
    const format = FORMAT_ORDER[os].indexOf(artifact.format);
    const arch = archOrder.indexOf(artifact.arch);
    return (format < 0 ? 99 : format) * 10 + (arch < 0 ? 9 : arch);
  };
  return offer.artifacts.filter((artifact) => artifact.os === os).sort((a, b) => rank(a) - rank(b));
}

/** The banner of a version stays hidden after "Later", for that version only: the next one is announced again. */
const LATER_KEY = 'rooks-update-later';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : machineScopedStorage(window.localStorage);
  } catch {
    return null;
  }
}

type Snapshot = { status: UpdateStatus | null; later: string | null; checking: boolean };

let snapshot: Snapshot = { status: null, later: null, checking: false };
const subscribers = new Set<() => void>();
let stopStream: (() => void) | null = null;
let inflight: Promise<void> | null = null;

function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const notify of subscribers) notify();
}

function parseStatus(value: unknown): UpdateStatus | null {
  if (!value || typeof value !== 'object') return null;
  const status = value as UpdateStatus;
  return typeof status.installed === 'string' && typeof status.state === 'string' ? status : null;
}

/** One read of the status, outside the store. A refusal (signed out, module off) or a failure is `null`. */
export function fetchUpdateStatus(fetcher: typeof fetch = fetch): Promise<UpdateStatus | null> {
  return fetcher(UPDATES_URL, { cache: 'no-store' })
    .then(async (res) => (res.ok ? parseStatus(await res.json()) : null))
    .catch(() => null);
}

/**
 * States the daemon has not settled yet: its first check leaves 30 to 90 s
 * after boot (`unchecked`), and a failed one is retried on its own schedule.
 */
export function updateStatusPending(status: UpdateStatus | null): boolean {
  return status?.state === 'unchecked' || status?.state === 'failed';
}

/** How often a screen that cannot hear the event stream reads a pending status again. */
export const UPDATE_STATUS_RETRY_MS = 30_000;

/**
 * Reads the status now, then again every `intervalMs` while it is pending —
 * for a screen with no event stream (the lock screen of an ended build). Stops
 * at the first settled state, a refusal or a failure (`null`), and when the
 * returned function is called. One read at a time: the next waits for the last.
 */
export function watchUpdateStatus(
  onStatus: (status: UpdateStatus | null) => void,
  options: { intervalMs?: number; fetcher?: typeof fetch } = {},
): () => void {
  const intervalMs = options.intervalMs ?? UPDATE_STATUS_RETRY_MS;
  let live = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const read = (): void => {
    void fetchUpdateStatus(options.fetcher).then((status) => {
      if (!live) return;
      onStatus(status);
      if (updateStatusPending(status)) timer = setTimeout(read, intervalMs);
    });
  };
  read();
  return () => {
    live = false;
    if (timer) clearTimeout(timer);
  };
}

/** Reads the status again. A refusal (signed out, module off) means no banner. */
export function loadUpdateStatus(fetcher: typeof fetch = fetch): Promise<void> {
  inflight ??= fetchUpdateStatus(fetcher)
    .then((status) => publish({ status }))
    .finally(() => { inflight = null; });
  return inflight;
}

/** Asks the daemon to check now (`settings:write`); the status it answers replaces the one shown. */
export async function checkForUpdatesNow(fetcher: typeof fetch = fetch): Promise<UpdateStatus | null> {
  publish({ checking: true });
  try {
    const res = await fetcher(UPDATES_CHECK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const status = res.ok ? parseStatus(await res.json()) : null;
    if (status) publish({ status });
    return status;
  } catch {
    return null;
  } finally {
    publish({ checking: false });
  }
}

export function remindLater(version: string): void {
  try { storage()?.setItem(LATER_KEY, version); } catch { /* storage refused: hidden for this page only */ }
  publish({ later: version });
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) {
    let later: string | null = null;
    try { later = storage()?.getItem(LATER_KEY) ?? null; } catch { /* no storage: nothing remembered */ }
    snapshot = { ...snapshot, later };
    void loadUpdateStatus();
    // The daemon announces a newly found version on the global stream.
    stopStream = sseOn('update_available', () => { void loadUpdateStatus(); });
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) { stopStream?.(); stopStream = null; }
  };
}

const getSnapshot = (): Snapshot => snapshot;
const getServerSnapshot = (): Snapshot => ({ status: null, later: null, checking: false });

export function useUpdateStore(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The offer to show now: a verified newer version the person did not put off. */
export function visibleOffer(state: Snapshot): UpdateOffer | null {
  const offer = state.status?.state === 'available' ? state.status.available : null;
  return offer && offer.version !== state.later ? offer : null;
}

export function resetUpdateStoreForTests(): void {
  snapshot = { status: null, later: null, checking: false };
  subscribers.clear();
  stopStream?.();
  stopStream = null;
  inflight = null;
}
