'use client';

import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, getLocale, t } from '@rooks/ui';
import type { ModelListing, SpeechState, StartedSession } from './desktop-speech';
import { localEngine } from './local-engine';
import { formatBytes, modelErrorKey, type ModelView } from './model-view';
import { subscribeVoiceSettings, voiceSettings, type VoiceSettings } from './voice-settings';

/**
 * The pieces the consent card and the settings pane share: the desktop's
 * state as React reads it, the progress line, and the buttons of a download
 * in flight. One place, so pausing from the card and resuming from the
 * settings are the same gesture.
 */

const noSubscription = () => () => {};
const noState = (): SpeechState | null => null;
const noModels = (): readonly ModelListing[] | null => null;
const noSession = (): StartedSession | null => null;
const NO_OFFERS: readonly ModelListing[] = [];
const noOffers = (): readonly ModelListing[] => NO_OFFERS;

export function useLocalEngineState(): SpeechState | null {
  const engine = localEngine();
  return useSyncExternalStore(
    engine ? (listener) => engine.subscribe(listener) : noSubscription,
    engine ? () => engine.snapshot() : noState,
    noState,
  );
}

/** The desktop's catalog; null before its answer, or from a desktop that cannot list it. */
export function useLocalModels(): readonly ModelListing[] | null {
  const engine = localEngine();
  return useSyncExternalStore(
    engine ? (listener) => engine.subscribe(listener) : noSubscription,
    engine ? () => engine.models() : noModels,
    noModels,
  );
}

/** The models the installed plugins offer, read again each time the pane opens. */
export function useLocalPackOffers(): readonly ModelListing[] {
  const engine = localEngine();
  useEffect(() => { void engine?.loadOffers(); }, [engine]);
  return useSyncExternalStore(
    engine ? (listener) => engine.subscribe(listener) : noSubscription,
    engine ? () => engine.offers() : noOffers,
    noOffers,
  );
}

export function useLastSession(): StartedSession | null {
  const engine = localEngine();
  return useSyncExternalStore(
    engine ? (listener) => engine.subscribe(listener) : noSubscription,
    engine ? () => engine.lastSession() : noSession,
    noSession,
  );
}

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(subscribeVoiceSettings, voiceSettings, voiceSettings);
}

export function modelSize(view: ModelView): string {
  return formatBytes(view.totalBytes, getLocale());
}

/** One line: where the download is, or why it stopped. */
export function ModelStatusLine({ view }: { view: ModelView }): ReactElement | null {
  const locale = getLocale();
  const progress = { received: formatBytes(view.receivedBytes, locale), total: formatBytes(view.totalBytes, locale) };
  switch (view.phase) {
    case 'loading':
      return <p className="text-[12px] text-muted-foreground">{t('dictation.model.loading')}</p>;
    case 'unavailable':
      return <p className="text-[12px] text-muted-foreground">{t('dictation.model.unavailable')}</p>;
    case 'consent':
      return null;
    case 'downloading':
    case 'paused':
      return (
        <div className="space-y-1.5">
          <div
            role="progressbar"
            aria-label={t('dictation.model.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.percent}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${view.percent}%` }} />
          </div>
          <p className="text-[12px] tabular-nums text-muted-foreground">
            {t(view.phase === 'paused' ? 'dictation.model.paused' : 'dictation.model.downloading', progress)}
          </p>
        </div>
      );
    case 'verifying':
      return (
        <p className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {t('dictation.model.verifying')}
        </p>
      );
    case 'ready':
      return <p className="text-[12px] text-muted-foreground">{t('dictation.model.ready', { size: modelSize(view) })}</p>;
    case 'error':
      return (
        <p role="alert" className="text-[12px] text-destructive">
          {t(modelErrorKey(view.error ?? 'io'), { size: modelSize(view) })}
        </p>
      );
  }
}

/**
 * The buttons of the current phase. `onCancelled` runs after a cancel has
 * deleted what was downloaded (the card closes itself there). `modelId`:
 * the model of the catalog they act on; none, the desktop's default one.
 */
export function ModelActions({
  view,
  modelId,
  downloadLabel,
  onAccept,
  onCancelled,
  onClose,
}: {
  view: ModelView;
  modelId?: string;
  /** The Download button's text; the plain verb by default. */
  downloadLabel?: string;
  onAccept?: () => void;
  onCancelled?: () => void;
  onClose?: () => void;
}): ReactElement | null {
  const engine = localEngine();
  if (!engine) return null;
  const download = () => {
    onAccept?.();
    void engine.download(modelId);
  };
  const cancel = () => {
    void engine.remove(modelId).then(() => onCancelled?.());
  };
  switch (view.phase) {
    case 'consent':
      return (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={download}>{downloadLabel ?? t('dictation.model.download')}</Button>
          {onClose ? <Button size="sm" variant="ghost" onClick={onClose}>{t('dictation.model.cancel')}</Button> : null}
        </div>
      );
    case 'downloading':
      return (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => { void engine.pause(modelId); }}>{t('dictation.model.pause')}</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>{t('dictation.model.cancel')}</Button>
        </div>
      );
    case 'paused':
      return (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={download}>{t('dictation.model.resume')}</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>{t('dictation.model.cancel')}</Button>
        </div>
      );
    case 'error':
      return (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={download}>{t('dictation.model.retry')}</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>{t('dictation.model.cancel')}</Button>
        </div>
      );
    case 'ready':
      return onClose ? <Button size="sm" variant="secondary" onClick={onClose}>{t('dictation.model.close')}</Button> : null;
    case 'loading':
    case 'verifying':
    case 'unavailable':
      return onClose ? <Button size="sm" variant="ghost" onClick={onClose}>{t('dictation.model.close')}</Button> : null;
  }
}
