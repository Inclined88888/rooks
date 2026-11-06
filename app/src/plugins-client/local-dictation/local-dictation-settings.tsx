'use client';

import { useState, type ReactElement } from 'react';

import { Button, getLocale, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, t } from '@timon/ui';
import type { InterimChoice, ModelListing, SpeechState } from './desktop-speech';
import { localEngine } from './local-engine';
import { ModelCatalog } from './model-catalog';
import {
  ModelActions, ModelStatusLine, modelSize, useLastSession, useLocalEngineState, useLocalModels, useLocalPackOffers, useVoiceSettings,
} from './model-controls';
import { ModelImport } from './model-import';
import {
  activeModel, automaticModel, catalogLanguages, chosenModel, effectiveLanguage, formatBytes, languageName, modelChoices,
  modelStateView, modelView, preciseSuggestion,
} from './model-view';
import { updateVoiceSettings, type VoiceSettings } from './voice-settings';

/**
 * Settings → Interface → Voice dictation, desktop app only (vault note §4):
 * the dictation language, the provisional text, the catalog of speech
 * models (download, cancel, delete), the model per language and the import
 * of a local model. All of it is kept by this client: the models are on
 * this machine. A desktop that cannot list its catalog gets the pane of its
 * single model, as before.
 */
export function LocalDictationSettings(): ReactElement {
  const state = useLocalEngineState();
  const models = useLocalModels();
  return (
    <section className="mt-8 max-w-2xl space-y-4">
      <div>
        <h3 className="text-[13px] font-semibold tracking-[-0.01em]">{t('dictation.settings.title')}</h3>
        <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('dictation.voice.intro')}</p>
      </div>
      {models ? <VoicePane state={state} models={models} /> : <SingleModelPane state={state} />}
    </section>
  );
}

/** A desktop older than the catalog: one model, its state, download, delete. */
function SingleModelPane({ state }: { state: SpeechState | null }): ReactElement {
  // A click on Download here IS the consent: a partial download shows as paused.
  const view = modelView(state, true);
  const [deleting, setDeleting] = useState(false);
  const engine = localEngine();
  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-4">
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
        {view.totalBytes > 0 ? t('dictation.settings.description', { size: modelSize(view) }) : t('dictation.settings.descriptionNoSize')}
      </p>
      {view.phase === 'consent' ? (
        <p className="text-[12px] text-muted-foreground">{t('dictation.settings.notDownloaded')}</p>
      ) : (
        <ModelStatusLine view={view} />
      )}
      {view.phase === 'ready' && engine ? (
        <Button
          size="sm"
          variant="outline"
          disabled={deleting}
          onClick={() => {
            setDeleting(true);
            void engine.remove().finally(() => setDeleting(false));
          }}
        >
          {t('dictation.settings.delete')}
        </Button>
      ) : (
        <ModelActions view={view} />
      )}
    </div>
  );
}

const INTERIM_CHOICES: ReadonlyArray<{ value: InterimChoice; key: string }> = [
  { value: 'auto', key: 'auto' },
  { value: 'live', key: 'live' },
  { value: 'delayed', key: 'delayed' },
  { value: 'final-only', key: 'finalOnly' },
];

/** `__` cannot start a model id: the value of "automatic" in the per-language lists. */
const AUTOMATIC = '__automatic';

function languageLabel(code: string, locale: string, inSentence = false): string {
  return code === 'auto' ? t('dictation.voice.auto') : languageName(code, locale, inSentence);
}

/** The languages of the per-language list: Auto, the dictation language, and those with a real choice. */
export function perLanguageRows(lang: string, settings: VoiceSettings, models: readonly ModelListing[]): string[] {
  const rows = new Set(['auto']);
  if (lang !== 'auto') rows.add(lang);
  for (const code of catalogLanguages(models)) {
    if (modelChoices(code, models).length > 1 || chosenModel(code, settings, models)) rows.add(code);
  }
  return [...rows];
}

function VoicePane({ state, models }: { state: SpeechState | null; models: readonly ModelListing[] }): ReactElement {
  const settings = useVoiceSettings();
  const last = useLastSession();
  const offers = useLocalPackOffers();
  const locale = getLocale();
  const lang = effectiveLanguage(settings.language, locale, models);
  const engine = state?.engine ?? 'available';
  const active = activeModel(lang, settings, models);
  const usedFor = new Map<string, string[]>(active ? [[active.id, [languageLabel(lang, locale)]]] : []);
  const precise = engine === 'available' ? preciseSuggestion(lang, models) : null;
  const lastModel = last ? models.find((entry) => entry.id === last.modelId)?.label ?? last.modelId : null;

  return (
    <>
      <div className="space-y-4 rounded-lg bg-muted/40 p-4">
        <div className="space-y-1.5">
          <p id="dictation-language-label" className="text-[13px] font-medium">{t('dictation.voice.language')}</p>
          <Select value={lang} onValueChange={(value) => { updateVoiceSettings((current) => ({ ...current, language: value })); }}>
            <SelectTrigger aria-labelledby="dictation-language-label" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('dictation.voice.auto')}</SelectItem>
              {catalogLanguages(models).map((code) => (
                <SelectItem key={code} value={code}>{languageName(code, locale)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t(lang === 'auto' ? 'dictation.voice.languageAutoHint' : 'dictation.voice.languageHint', { language: languageLabel(lang, locale, true) })}
          </p>
        </div>
        <div className="space-y-1.5">
          <p id="dictation-interim-label" className="text-[13px] font-medium">{t('dictation.voice.interim')}</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="dictation-interim-label">
            {INTERIM_CHOICES.map((choice) => (
              <Button
                key={choice.value}
                size="sm"
                variant={settings.interim === choice.value ? 'secondary' : 'ghost'}
                aria-pressed={settings.interim === choice.value}
                onClick={() => { updateVoiceSettings((current) => ({ ...current, interim: choice.value })); }}
              >
                {t(`dictation.voice.interimChoices.${choice.key}`)}
              </Button>
            ))}
          </div>
          <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('dictation.voice.interimHint')}</p>
        </div>
        {last && lastModel ? (
          <p className="text-[12px] text-muted-foreground">
            {t('dictation.voice.lastSession', {
              model: lastModel,
              language: languageLabel(last.language ?? 'auto', locale, true),
              interim: t(`dictation.voice.interimChoices.${last.interim === 'final-only' ? 'finalOnly' : last.interim}`),
            })}
          </p>
        ) : null}
      </div>

      {precise ? <PreciseModelCard entry={precise} lang={lang} engine={engine} /> : null}

      <div className="space-y-3">
        <h4 className="text-[13px] font-semibold">{t('dictation.catalog.title')}</h4>
        {engine === 'available' ? (
          <>
            <ModelImport models={models} />
            <ModelCatalog models={models} offers={offers} engine={engine} usedFor={usedFor} />
          </>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t('dictation.model.unavailable')}</p>
        )}
      </div>

      {engine === 'available' ? <PerLanguageModels lang={lang} settings={settings} models={models} /> : null}
    </>
  );
}

/** "A precise model for French": Parakeet alone dictates it, Canary would impose it. */
function PreciseModelCard({ entry, lang, engine }: { entry: ModelListing; lang: string; engine: SpeechState['engine'] }): ReactElement {
  const locale = getLocale();
  // The click on Download is the consent, as in the card of the first dictation.
  const view = modelStateView(engine, entry.state, true);
  const language = languageName(lang, locale, true);
  const size = formatBytes(entry.sizeBytes, locale);
  return (
    <div className="space-y-2 rounded-lg bg-primary/5 p-4">
      <p className="text-[13px] font-medium">{t('dictation.voice.preciseTitle', { language, size })}</p>
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
        {t('dictation.voice.preciseBody', { model: entry.label, language })}
      </p>
      {view.phase !== 'consent' ? <ModelStatusLine view={view} /> : null}
      <ModelActions view={view} modelId={entry.id} downloadLabel={t('dictation.catalog.download', { size })} />
    </div>
  );
}

function PerLanguageModels({ lang, settings, models }: { lang: string; settings: VoiceSettings; models: readonly ModelListing[] }): ReactElement {
  const locale = getLocale();
  return (
    <details className="group rounded-lg bg-muted/40 p-4">
      <summary className="cursor-pointer text-[13px] font-medium">{t('dictation.voice.perLanguage')}</summary>
      <p className="mt-2 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('dictation.voice.perLanguageHint')}</p>
      <ul className="mt-3 space-y-2">
        {perLanguageRows(lang, settings, models).map((code) => {
          const choices = modelChoices(code, models);
          const chosen = chosenModel(code, settings, models);
          const automatic = automaticModel(code, models);
          const id = `dictation-model-${code}`;
          return (
            <li key={code} className="flex flex-wrap items-center justify-between gap-2">
              <span id={id} className="text-[13px]">{languageLabel(code, locale)}</span>
              <Select
                value={chosen?.id ?? AUTOMATIC}
                disabled={choices.length === 0}
                onValueChange={(value) => {
                  updateVoiceSettings((current) => {
                    const next = { ...current.models };
                    if (value === AUTOMATIC) delete next[code];
                    else next[code] = value;
                    return { ...current, models: next };
                  });
                }}
              >
                <SelectTrigger aria-labelledby={id} className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTOMATIC}>
                    {automatic ? t('dictation.voice.automaticModel', { model: automatic.label }) : t('dictation.voice.automatic')}
                  </SelectItem>
                  {choices.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
