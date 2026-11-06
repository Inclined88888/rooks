'use client';

import { useState, type ReactElement } from 'react';
import { Mic } from 'lucide-react';

import { getLocale, t } from '@timon/ui';
import { effectiveLanguage, modelStateView, modelView, recommendedModel } from './model-view';
import { ModelActions, ModelStatusLine, modelSize, useLocalEngineState, useLocalModels, useVoiceSettings } from './model-controls';

/**
 * The card a first click on the microphone opens in the desktop app while
 * the speech model is not on disk: what will be downloaded, how big, and
 * that the voice stays local — then the download itself, with pause, resume
 * and cancel. Nothing is ever downloaded without the click on Download.
 *
 * The model is the one the dictation language runs on once installed
 * (Canary for French, Parakeet for Auto); from a desktop that cannot list
 * its catalog, its default model.
 */
export function LocalModelConsentCard({ onClose }: { onClose: () => void }): ReactElement {
  const state = useLocalEngineState();
  const models = useLocalModels();
  const settings = useVoiceSettings();
  const [accepted, setAccepted] = useState(false);
  const target = models ? recommendedModel(effectiveLanguage(settings.language, getLocale(), models), models) : null;
  const view = state && target ? modelStateView(state.engine, target.state, accepted) : modelView(state, accepted);

  return (
    <div
      role="dialog"
      aria-labelledby="local-dictation-consent-title"
      className="w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-xl bg-background p-4 text-foreground shadow-lg ring-1 ring-foreground/5"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Mic className="size-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 id="local-dictation-consent-title" className="text-[13px] font-semibold leading-snug">
            {t('dictation.model.consentTitle')}
          </h2>
          {view.phase === 'consent' ? (
            <p className="text-[12px] leading-snug text-muted-foreground">
              {target
                ? t('dictation.model.consentBodyModel', { model: target.label, size: modelSize(view) })
                : t('dictation.model.consentBody', { size: modelSize(view) })}
            </p>
          ) : null}
        </div>
      </div>
      <ModelStatusLine view={view} />
      <ModelActions view={view} modelId={target?.id} onAccept={() => setAccepted(true)} onCancelled={onClose} onClose={onClose} />
    </div>
  );
}
