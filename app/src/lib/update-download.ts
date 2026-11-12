'use client';

/**
 * The desktop shell's download and installation of a newer Rooks
 * (docs/AUTO-UPDATE.md §6, P2 and P3), as the banner sees it.
 *
 * Only the shell downloads: it reads the verified offer from its own daemon
 * and names the installer itself, so the page sends gestures and nothing else
 * — no URL, no path, no version. In a browser, in an older desktop, or in a
 * window showing another machine, the bridge is absent or refuses, and the
 * hook gives `null`: the banner keeps its plain download link.
 */
import { useEffect, useMemo, useState } from 'react';

export type UpdateDownloadErrorCode =
  | 'no_offer' | 'daemon' | 'network' | 'http' | 'insecure_redirect' | 'too_many_redirects'
  | 'size' | 'integrity' | 'disk_full' | 'filesystem';

export type UpdateDownloadFormat = 'appimage' | 'deb' | 'pkg' | 'dmg' | 'nsis';

export type UpdateDownloadState =
  | { phase: 'idle' }
  | { phase: 'downloading'; version: string; name: string; format: UpdateDownloadFormat; received: number; total: number }
  | { phase: 'verifying'; version: string; name: string; format: UpdateDownloadFormat; total: number }
  | { phase: 'ready'; version: string; name: string; format: UpdateDownloadFormat; total: number }
  | { phase: 'failed'; version: string | null; name: string | null; code: UpdateDownloadErrorCode; resumable: boolean };

export type UpdateOpenOutcome = { status: 'opened' | 'none' | 'unsupported' } | { status: 'failed'; message: string | null };

/**
 * What `install` did (P3). `missions`: nothing, `count` missions run and
 * installing would stop them — ask, then `install(true)`. `unsupported`: an
 * older desktop that cannot install; open the installer instead.
 */
export type UpdateInstallOutcome =
  | { status: 'missions'; count: number }
  | { status: 'restarting' | 'not_writable' | 'opened' | 'closing' | 'none' | 'unsupported' }
  | { status: 'guided'; command: string; opened: boolean }
  | { status: 'failed'; message: string | null };

/** What an `updates.banner` occupant drives; `null` outside the desktop app. */
export type UpdateDownloadControl = {
  state: UpdateDownloadState;
  /** Downloads the installer the daemon verified for this machine. Takes nothing. */
  start: () => void;
  /** Stops it and deletes what was downloaded. */
  cancel: () => void;
  /** Shows the verified installer in the file manager. */
  openFolder: () => Promise<UpdateOpenOutcome>;
  /** Opens the verified installer with the system (not an AppImage: `unsupported`). */
  openInstaller: () => Promise<UpdateOpenOutcome>;
  /** Installs the verified file the system's way; `confirmed` = install past running missions. */
  install: (confirmed?: boolean) => Promise<UpdateInstallOutcome>;
};

export type UpdatesBridge = {
  state: () => Promise<unknown>;
  start: () => Promise<unknown>;
  cancel: () => Promise<unknown>;
  open: (target: 'folder' | 'installer') => Promise<unknown>;
  install?: (confirmed: boolean) => Promise<unknown>;
  onState: (listener: (state: unknown) => void) => () => void;
};

const PHASES = new Set(['idle', 'downloading', 'verifying', 'ready', 'failed']);

export function parseDownloadState(value: unknown): UpdateDownloadState | null {
  if (!value || typeof value !== 'object') return null;
  const phase = (value as { phase?: unknown }).phase;
  return typeof phase === 'string' && PHASES.has(phase) ? value as UpdateDownloadState : null;
}

function parseOutcome(value: unknown): UpdateOpenOutcome {
  const status = value && typeof value === 'object' ? (value as { status?: unknown }).status : null;
  if (status === 'opened' || status === 'none' || status === 'unsupported') return { status };
  const message = value && typeof value === 'object' ? (value as { message?: unknown }).message : null;
  return { status: 'failed', message: typeof message === 'string' ? message : null };
}

const INSTALL_STATUSES = new Set(['restarting', 'not_writable', 'opened', 'closing', 'none', 'unsupported']);

export function parseInstallOutcome(value: unknown): UpdateInstallOutcome {
  const read = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const { status } = read;
  if (status === 'missions' && typeof read.count === 'number' && read.count > 0) return { status, count: read.count };
  if (status === 'guided' && typeof read.command === 'string') return { status, command: read.command, opened: read.opened === true };
  if (typeof status === 'string' && INSTALL_STATUSES.has(status)) return { status: status as 'restarting' };
  return { status: 'failed', message: typeof read.message === 'string' ? read.message : null };
}

export function updatesBridge(): UpdatesBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge: Partial<UpdatesBridge> | undefined = window.rooksDesktop?.updates;
  if (!bridge || typeof bridge.state !== 'function' || typeof bridge.start !== 'function' || typeof bridge.cancel !== 'function'
    || typeof bridge.open !== 'function' || typeof bridge.onState !== 'function') return null;
  return bridge as UpdatesBridge;
}

/**
 * The state shown for `version`: a download or a verdict about another
 * version (an older offer, since replaced) is not this one's.
 */
export function stateFor(state: UpdateDownloadState, version: string): UpdateDownloadState {
  if (state.phase === 'idle') return state;
  if (state.phase === 'failed' && state.version === null) return state;
  return state.version === version ? state : { phase: 'idle' };
}

/**
 * The shell's download for the version on offer, or `null` when this page
 * cannot download (a browser, an older desktop, a window on another machine).
 */
export function useUpdateDownload(version: string | null, override?: UpdatesBridge | null): UpdateDownloadControl | null {
  const [bridge] = useState<UpdatesBridge | null>(() => (override !== undefined ? override : updatesBridge()));
  const [state, setState] = useState<UpdateDownloadState | null>(null);
  useEffect(() => {
    if (!bridge || !version) return undefined;
    let live = true;
    const stop = bridge.onState((next) => {
      const parsed = parseDownloadState(next);
      if (live && parsed) setState(parsed);
    });
    // The shell refuses a window it does not download for: the link stays.
    bridge.state().then((read) => { if (live) setState(parseDownloadState(read)); }, () => { if (live) setState(null); });
    return () => { live = false; stop(); };
  }, [bridge, version]);
  return useMemo(() => {
    if (!bridge || !version || !state) return null;
    const apply = (read: unknown): void => { const parsed = parseDownloadState(read); if (parsed) setState(parsed); };
    return {
      state: stateFor(state, version),
      start: () => { bridge.start().then(apply, () => undefined); },
      cancel: () => { bridge.cancel().then(apply, () => undefined); },
      openFolder: () => bridge.open('folder').then(parseOutcome, () => ({ status: 'failed', message: null })),
      openInstaller: () => bridge.open('installer').then(parseOutcome, () => ({ status: 'failed', message: null })),
      install: (confirmed = false) => (bridge.install
        ? bridge.install(confirmed === true).then(parseInstallOutcome, () => ({ status: 'failed', message: null }) as const)
        : Promise.resolve({ status: 'unsupported' } as const)),
    };
  }, [bridge, state, version]);
}
