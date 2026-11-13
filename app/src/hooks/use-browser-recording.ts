'use client';

/**
 * `useBrowserRecording()` — the recording of the built-in browser an occupant
 * of `browser.toolbar` / `browser.drawer` is painted in (TODO #461). The record
 * button and the review drawer of `@rooks/browser-recording` are built on it,
 * and a third-party plugin can be too (exported by `@rooks/ui`).
 *
 * Reading is free: `live` comes from the browser status, which every viewer of
 * the profile receives. Everything that acts goes through the plugin's daemon
 * routes, which admit the profile's owner only, and is gated here like the
 * `command()` of `useBrowserChrome()`: the occupant's plugin must declare
 * `browser:control`, read from the slot entry, not from the plugin.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { browserControlDenied, useBrowserChrome, useBrowserOccupantPlugin } from '@/components/browser-chrome';
import {
  BROWSER_CONTROL_PERMISSION, clientPermissionsVersion, clientPluginHolds, subscribeClientPermissions,
} from '@/lib/plugin-host/plugin-permissions';
import {
  browserRecordingApi, browserRecordingState, loadBrowserRecordings, replaceBrowserRecording, subscribeBrowserRecordings,
  updateBrowserRecordingState,
  type BrowserRecordingDetail, type BrowserRecordingLive, type BrowserRecordingMeta, type BrowserRecordingOp,
  type BrowserRecordingLearnOptions, type LearnedBrowserRecording, type RecordedStep, type StoppedBrowserRecording,
} from '@/lib/browser-recording';

/** Key of the review drawer of `@rooks/browser-recording` in `browser.drawer`. */
export const BROWSER_RECORDING_REVIEW_DRAWER = 'recording-review';

export type BrowserRecordingHandle = {
  profileId: string | null;
  /** The engine's recording state, `null` while the browser reports none. */
  live: BrowserRecordingLive | null;
  /** The signed-in user owns the profile; `null` until known. Only the owner records, stops and reviews. */
  owner: boolean | null;
  /** This client holds the control lease: recording starts here only (the PWA included). */
  controlled: boolean;
  /** Record can be pressed now. */
  canStart: boolean;
  recordings: BrowserRecordingMeta[];
  /** The recording the review drawer shows, `null` for the list. */
  selectedId: string | null;
  /** The last Stop found that recording already saved: it had ended on its own and the daemon collected it. */
  alreadySaved: boolean;
  busy: boolean;
  error: string | null;
  start(): Promise<void>;
  /** Stops (or collects a recording that ended on its own) and opens its review. */
  stop(): Promise<StoppedBrowserRecording>;
  /** Opens the review drawer on a recording, or on the list. */
  openReview(id?: string | null): void;
  refresh(): Promise<void>;
  /** Reads a recording with its masked steps. */
  read(id: string): Promise<BrowserRecordingDetail>;
  patch(id: string, ops: BrowserRecordingOp[]): Promise<{ recording: BrowserRecordingMeta; steps: RecordedStep[] }>;
  remove(id: string): Promise<void>;
  learn(id: string, options: BrowserRecordingLearnOptions): Promise<LearnedBrowserRecording>;
};

function liveOf(status: unknown): BrowserRecordingLive | null {
  const recording = status && typeof status === 'object' ? (status as { recording?: unknown }).recording : undefined;
  if (!recording || typeof recording !== 'object') return null;
  const { active, steps, stoppedReason } = recording as Record<string, unknown>;
  if (typeof active !== 'boolean') return null;
  return { active, steps: typeof steps === 'number' ? steps : 0, ...(typeof stoppedReason === 'string' ? { stoppedReason } : {}) };
}

export function useBrowserRecording(): BrowserRecordingHandle | null {
  const chrome = useBrowserChrome();
  const pluginId = useBrowserOccupantPlugin();
  useSyncExternalStore(subscribeClientPermissions, clientPermissionsVersion, clientPermissionsVersion);
  const allowed = clientPluginHolds(pluginId, BROWSER_CONTROL_PERMISSION);
  const profileId = chrome?.profileId ?? null;
  const state = useSyncExternalStore(subscribeBrowserRecordings, () => browserRecordingState(profileId), () => browserRecordingState(profileId));
  const seen = liveOf(chrome?.status);
  // Rebuilt from every status poll: keep one object while its fields hold.
  const live = useMemo<BrowserRecordingLive | null>(
    () => (seen ? { active: seen.active, steps: seen.steps, ...(seen.stoppedReason ? { stoppedReason: seen.stoppedReason } : {}) } : null),
    [seen?.active, seen?.steps, seen?.stoppedReason], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const running = chrome?.status?.running === true;

  useEffect(() => { if (profileId) void loadBrowserRecordings(profileId); }, [profileId]);
  // A recording that just ended (stopped here, elsewhere, or on its own) lands in the list.
  const liveKey = live ? `${live.active}:${live.stoppedReason ?? ''}` : 'none';
  const previousLive = useRef(liveKey);
  useEffect(() => {
    if (previousLive.current === liveKey) return;
    previousLive.current = liveKey;
    if (profileId) void loadBrowserRecordings(profileId);
  }, [liveKey, profileId]);

  const openDrawer = chrome?.openDrawer;
  const guard = useCallback(<T,>(run: (profile: string) => Promise<T>): Promise<T> => {
    if (!profileId) return Promise.reject(new Error('No browser profile.'));
    if (!allowed) {
      const denied = browserControlDenied(pluginId);
      updateBrowserRecordingState(profileId, { error: denied.message });
      return Promise.reject(denied);
    }
    return run(profileId);
  }, [allowed, pluginId, profileId]);
  const busyWhile = useCallback(async <T,>(profile: string, run: () => Promise<T>): Promise<T> => {
    updateBrowserRecordingState(profile, { busy: true, error: null });
    try { return await run(); }
    catch (error) { updateBrowserRecordingState(profile, { error: (error as Error).message }); throw error; }
    finally { updateBrowserRecordingState(profile, { busy: false }); }
  }, []);

  const openReview = useCallback((id: string | null = null) => {
    if (!profileId) return;
    updateBrowserRecordingState(profileId, { selectedId: id, alreadySaved: false });
    openDrawer?.(BROWSER_RECORDING_REVIEW_DRAWER);
  }, [profileId, openDrawer]);

  const start = useCallback(() => guard((profile) => busyWhile(profile, async () => { await browserRecordingApi.start(profile); })), [guard, busyWhile]);
  const stop = useCallback(() => guard((profile) => busyWhile(profile, async () => {
    try {
      const stopped = await browserRecordingApi.stop(profile);
      replaceBrowserRecording(profile, stopped.recording);
      // Saved earlier by the daemon or just now, the answer names the recording: its review opens either way.
      updateBrowserRecordingState(profile, { selectedId: stopped.recording.id, alreadySaved: stopped.alreadySaved === true });
      openDrawer?.(BROWSER_RECORDING_REVIEW_DRAWER);
      return stopped;
    } finally { void loadBrowserRecordings(profile); }
  })), [guard, busyWhile, openDrawer]);
  const refresh = useCallback(() => (profileId ? loadBrowserRecordings(profileId) : Promise.resolve()), [profileId]);
  const read = useCallback((id: string) => guard(() => browserRecordingApi.get(id)), [guard]);
  const patch = useCallback((id: string, ops: BrowserRecordingOp[]) => guard(async (profile) => {
    const result = await browserRecordingApi.patch(id, ops);
    replaceBrowserRecording(profile, result.recording);
    return result;
  }), [guard]);
  const remove = useCallback((id: string) => guard(async (profile) => {
    await browserRecordingApi.remove(id);
    updateBrowserRecordingState(profile, (current) => ({
      recordings: current.recordings.filter((row) => row.id !== id),
      selectedId: current.selectedId === id ? null : current.selectedId,
    }));
  }), [guard]);
  const learn = useCallback((id: string, options: BrowserRecordingLearnOptions) => guard(async (profile) => {
    const result = await browserRecordingApi.learn(id, options);
    replaceBrowserRecording(profile, result.recording);
    return result;
  }), [guard]);

  const controlled = chrome?.controlled === true;
  return useMemo(() => {
    if (!chrome) return null;
    return {
      profileId, live, owner: state.owner, controlled,
      canStart: allowed && state.owner === true && controlled && running && !state.busy && !live?.active && !live?.stoppedReason,
      recordings: state.recordings, selectedId: state.selectedId, alreadySaved: state.alreadySaved, busy: state.busy, error: state.error,
      start, stop, openReview, refresh, read, patch, remove, learn,
    };
  }, [chrome, profileId, live, state, controlled, running, allowed, start, stop, openReview, refresh, read, patch, remove, learn]);
}
