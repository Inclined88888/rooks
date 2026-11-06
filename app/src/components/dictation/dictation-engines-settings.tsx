'use client';

import { useEffect, useReducer, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  dictationChoice, dictationChoiceResetFrom, dismissDictationChoiceReset, resetDictationChoice, sameChoice, setDictationChoice,
  subscribeDictationChoice, type DictationChoice,
} from '@/lib/dictation/choice';
import { decideEngineConsent, engineConsent, forgetEngineConsent, subscribeEngineConsent, type EngineConsent } from '@/lib/dictation/consent';
import { dictationPluginLabel, engineDestination, isProductEngine, voiceDestinationLine } from '@/lib/dictation/destination';
import { dictationEngines, subscribeDictationEngines, type RegisteredEngine } from '@/lib/dictation/engines';
import { choiceGone, choiceLabel, currentDictationRoute, routeEngineId, webSpeechOffered } from '@/lib/dictation/recognition';
import { t } from '@/lib/i18n';
import { pluginsSynced, subscribePluginSync } from '@/lib/plugin-host/loader';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { settingsSlotForGroup } from '@/lib/plugin-host/settings-slots';
import { slotEntries } from '@/lib/plugin-host/slots';
import { cn } from '@/lib/utils';

import { presentEngineConsent, useActiveMachineName } from './engine-consent-card';

/**
 * Settings → Interface → Voice: which engine dictates (TODO #492), and for
 * each engine where it sends the voice and the user's consent (TODO #484 C3),
 * then its own settings panel — the component registered with it.
 *
 * Choosing is not consenting: a third-party engine chosen without consent
 * opens the card at once, and dictation stays gated on it either way. A
 * consent is given or withdrawn here as well; withdrawn, the card comes back
 * at the next dictation. Nothing is shown while no engine is registered and
 * nothing was chosen (a browser on Web Speech alone).
 */
export function DictationEnginesSettings(): ReactElement | null {
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const [mounted, setMounted] = useState(false);
  const machine = useActiveMachineName();
  useEffect(() => {
    setMounted(true);
    // A chosen engine whose plugin went away is reset here too, and said.
    const reconcile = () => {
      const choice = dictationChoice();
      if (choiceGone(choice, pluginsSynced())) resetDictationChoice(choiceLabel(choice));
      repaint();
    };
    const offEngines = subscribeDictationEngines(reconcile);
    const offConsent = subscribeEngineConsent(reconcile);
    const offChoice = subscribeDictationChoice(repaint);
    const offSync = subscribePluginSync(reconcile);
    reconcile();
    return () => { offEngines(); offConsent(); offChoice(); offSync(); };
  }, []);
  if (!mounted) return null;
  const engines = dictationEngines();
  const choice = dictationChoice();
  const resetFrom = dictationChoiceResetFrom();
  if (engines.length === 0 && choice.kind === 'auto' && !resetFrom) return null;
  const inUse = routeEngineId(currentDictationRoute());
  const missing = choice.kind === 'engine' && !engines.some(({ pluginId, engine }) => pluginId === choice.pluginId && engine.id === choice.engineId);
  const choose = (next: DictationChoice) => {
    setDictationChoice(next);
    if (next.kind !== 'engine') return;
    // The card at the choice rather than at the first dictation: the user is
    // here, thinking about this engine.
    if (engineConsent(next.pluginId, next.engineId) === 'ask') {
      presentEngineConsent({ pluginId: next.pluginId, engineId: next.engineId, engineLabel: next.label });
    }
  };

  return (
    <section className="mt-8 max-w-2xl space-y-3">
      <div>
        <h3 id="dictation-engine-choice" className="text-[13px] font-semibold tracking-[-0.01em]">{t('dictation.choice.title')}</h3>
        <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('dictation.choice.intro', { machine })}</p>
      </div>
      {resetFrom ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-500/10 p-3">
          <span className="text-[12px] leading-snug">{t('dictation.choice.resetNotice', { engine: resetFrom })}</span>
          <Button size="sm" variant="ghost" onClick={dismissDictationChoiceReset}>{t('dictation.choice.dismiss')}</Button>
        </div>
      ) : null}
      <ul role="radiogroup" aria-labelledby="dictation-engine-choice" className="m-0 list-none space-y-2 p-0">
        <ChoiceRow checked={choice.kind === 'auto'} onChoose={() => { choose({ kind: 'auto' }); }} title={t('dictation.choice.auto')}>
          <p className="text-[12px] leading-snug text-muted-foreground">{t('dictation.choice.autoHint')}</p>
        </ChoiceRow>
        {webSpeechOffered() || choice.kind === 'web-speech' ? (
          <ChoiceRow
            checked={choice.kind === 'web-speech'}
            onChoose={() => { choose({ kind: 'web-speech' }); }}
            title={webSpeechOffered() ? t('dictation.choice.webSpeech') : t('dictation.choice.unavailableOption', { engine: t('dictation.choice.webSpeech') })}
          >
            <p className="text-[12px] leading-snug text-muted-foreground">
              {webSpeechOffered() ? t('dictation.choice.webSpeechHint') : t('dictation.choice.chosenUnavailable')}
            </p>
          </ChoiceRow>
        ) : null}
        {engines.map((entry) => (
          <EngineRow
            key={`${entry.pluginId} ${entry.engine.id}`}
            entry={entry}
            machine={machine}
            inUse={inUse === entry.engine.id}
            checked={sameChoice(choice, { kind: 'engine', pluginId: entry.pluginId, engineId: entry.engine.id, label: entry.engine.label })}
            onChoose={choose}
          />
        ))}
        {missing ? (
          <ChoiceRow checked onChoose={() => {}} title={t('dictation.choice.unavailableOption', { engine: choice.label })}>
            <p className="text-[12px] leading-snug text-muted-foreground">{t('dictation.choice.chosenUnavailable')}</p>
          </ChoiceRow>
        ) : null}
      </ul>
    </section>
  );
}

/** One option of the choice: the radio is its title line, the rest of the card is free for buttons. */
function ChoiceRow({ checked, disabled = false, onChoose, title, badges, children, after }: {
  checked: boolean;
  disabled?: boolean;
  onChoose: () => void;
  title: string;
  badges?: ReactNode;
  children?: ReactNode;
  after?: ReactNode;
}): ReactElement {
  return (
    <li className="space-y-2">
      <div className={cn('space-y-2 rounded-lg bg-muted/40 p-4', checked && 'bg-primary/5 ring-1 ring-primary/40')}>
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          disabled={disabled}
          onClick={onChoose}
          className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span
            aria-hidden
            className={cn('relative top-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border', checked ? 'border-primary' : 'border-muted-foreground/50')}
          >
            {checked ? <span className="size-1.5 rounded-full bg-primary" /> : null}
          </span>
          <span className="text-[13px] font-medium leading-snug">{title}</span>
          {badges}
        </button>
        {children}
      </div>
      {after}
    </li>
  );
}

function EngineRow({ entry, machine, inUse, checked, onChoose }: {
  entry: RegisteredEngine;
  machine: string;
  inUse: boolean;
  checked: boolean;
  onChoose: (choice: DictationChoice) => void;
}): ReactElement {
  const { pluginId, engine } = entry;
  const product = isProductEngine(pluginId);
  const consent = engineConsent(pluginId, engine.id);
  return (
    <ChoiceRow
      checked={checked}
      // Without a declared destination the engine is never used: nothing to choose.
      disabled={consent === 'undeclared' && !checked}
      onChoose={() => { onChoose({ kind: 'engine', pluginId, engineId: engine.id, label: engine.label }); }}
      title={engine.label}
      badges={(
        <>
          {inUse ? (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">{t('dictation.engines.inUse')}</span>
          ) : null}
          {!product ? (
            <span className="text-[12px] font-normal text-muted-foreground">{t('dictation.consent.from', { plugin: dictationPluginLabel(pluginId) })}</span>
          ) : null}
        </>
      )}
      after={<EnginePanel pluginId={pluginId} Panel={entry.Panel} />}
    >
      <p className="text-[12px] leading-snug">{voiceDestinationLine(engineDestination(pluginId, engine.id), machine)}</p>
      {!product ? <ConsentLine pluginId={pluginId} engineId={engine.id} consent={consent} machine={machine} /> : null}
    </ChoiceRow>
  );
}

/**
 * The engine's settings panel, under its card, in the envelope of any slot
 * occupant: a panel that throws shows its error in place and the pane lives
 * on. A plugin that also grafted the same component in `settings.voice` (what
 * the SDK advised before the panel was painted here) keeps it there only,
 * rather than twice.
 */
function EnginePanel({ pluginId, Panel }: { pluginId: string; Panel: ComponentType }): ReactElement | null {
  const grafted = slotEntries(settingsSlotForGroup('Voice')).some((entry) => entry.pluginId === pluginId && entry.Component === Panel);
  if (grafted) return null;
  return <PluginBoundary pluginId={pluginId}><Panel /></PluginBoundary>;
}

function ConsentLine({ pluginId, engineId, consent, machine }: {
  pluginId: string;
  engineId: string;
  consent: EngineConsent;
  machine: string;
}): ReactElement | null {
  const allow = () => { decideEngineConsent(pluginId, engineId, 'granted'); };
  switch (consent) {
    case 'not-needed':
      return null;
    case 'undeclared':
      return <p className="text-[12px] leading-snug text-muted-foreground">{t('dictation.engines.undeclared')}</p>;
    case 'granted':
      return (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[12px] text-muted-foreground">{t('dictation.engines.granted', { machine })}</span>
          <Button size="sm" variant="outline" onClick={() => { forgetEngineConsent(pluginId, engineId); }}>
            {t('dictation.engines.withdraw')}
          </Button>
        </div>
      );
    case 'refused':
    case 'ask':
      return (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[12px] text-muted-foreground">
            {t(consent === 'refused' ? 'dictation.engines.refused' : 'dictation.engines.notAsked')}
          </span>
          <Button size="sm" variant="outline" onClick={allow}>{t('dictation.consent.allow')}</Button>
        </div>
      );
  }
}
