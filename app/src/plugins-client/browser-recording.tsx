'use client';

import dynamic from 'next/dynamic';
/**
 * Client half of `@rooks/browser-recording` (TODO #461): the record button and
 * its pill in the browser's address bar (`browser.toolbar`), and the review
 * drawer (`browser.drawer`). Both are slot occupants like a third-party
 * plugin's, built on `useBrowserRecording()`.
 */

import { AlertTriangle, Circle, ListVideo, Loader2, Square } from 'lucide-react';
import { BROWSER_DRAWER_SLOT, BROWSER_TOOLBAR_SLOT } from '@/components/browser-chrome';
import { BROWSER_RECORDING_REVIEW_DRAWER, useBrowserRecording } from '@/hooks/use-browser-recording';
import { stepCount } from '@/lib/browser-recording';
import { BROWSER_CONTROL_PERMISSION } from '@/lib/plugin-host/plugin-permissions';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { BundledClientPlugin } from './types';

// The review drawer opens on demand inside the browser: fetched then (docs/BUNDLE-SIZE.md).
const BrowserRecordingReview = dynamic(() => import('@/components/browser-recording-review').then((m) => m.BrowserRecordingReview), { ssr: false });

export const BROWSER_RECORDING_MODULE = '@rooks/browser-recording';

const iconButton = 'rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
const pillButton = 'rounded-full px-1.5 py-0.5 font-medium hover:bg-background/60 disabled:opacity-40';

/** `●` when idle; a pill while recording, or once a recording ended on its own and waits to be collected. */
export function BrowserRecordControl() {
  const recording = useBrowserRecording();
  if (!recording?.profileId) return null;
  const { live, owner } = recording;
  const failure = recording.error && <span role="alert" title={recording.error} className="text-destructive"><AlertTriangle className="size-3.5" /><span className="sr-only">{recording.error}</span></span>;
  const stop = () => { void recording.stop().catch(() => {}); };

  // Every viewer sees that the browser is recorded; only its owner stops it, from any device.
  if (live?.active || live?.stoppedReason) {
    const ended = !live.active;
    return (
      <div role="status" data-browser-recording={ended ? 'ended' : 'active'} className="flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 py-0.5 pl-2 pr-0.5 text-[11px] text-destructive">
        <span aria-hidden className={cn('size-2 rounded-full bg-destructive', !ended && 'animate-pulse')} />
        <span className="tabular-nums">{ended ? t('browserPanel.recording.ended') : t('browserPanel.recording.recording')} · {stepCount(live.steps)}</span>
        {owner === true && (
          <button type="button" className={cn(pillButton, 'flex items-center gap-1')} disabled={recording.busy} onClick={stop} title={ended ? t('browserPanel.recording.reviewTitle') : t('browserPanel.recording.stopTitle')}>
            {recording.busy ? <Loader2 className="size-3 animate-spin" /> : !ended && <Square className="size-2.5 fill-current" />}
            {ended ? t('browserPanel.recording.review') : t('browserPanel.recording.stop')}
          </button>
        )}
        {failure}
      </div>
    );
  }
  if (owner !== true) return null;
  const why = !recording.controlled ? t('browserPanel.recording.needsControl') : t('browserPanel.recording.recordTitle');
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" className={iconButton} disabled={!recording.canStart} aria-label={t('browserPanel.recording.record')} title={why} onClick={() => { void recording.start().catch(() => {}); }}>
        {recording.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Circle className="size-3.5 fill-destructive text-destructive" />}
      </button>
      {recording.recordings.length > 0 && (
        <button type="button" className={cn(iconButton, 'flex items-center gap-0.5 text-[10px] tabular-nums')} aria-label={t('browserPanel.recording.recordings')} title={t('browserPanel.recording.recordings')} onClick={() => recording.openReview(null)}>
          <ListVideo className="size-3.5" />{recording.recordings.length}
        </button>
      )}
      {failure}
    </div>
  );
}

export const browserRecordingClient: BundledClientPlugin = {
  module: BROWSER_RECORDING_MODULE,
  // `useBrowserRecording()` acts only for a plugin that holds it, like `command()`.
  permissions: [BROWSER_CONTROL_PERMISSION],
  apply(ctx) {
    ctx.register({ slot: BROWSER_TOOLBAR_SLOT }, BrowserRecordControl);
    ctx.register({ slot: BROWSER_DRAWER_SLOT, key: BROWSER_RECORDING_REVIEW_DRAWER }, BrowserRecordingReview);
  },
};
