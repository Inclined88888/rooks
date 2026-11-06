'use client';

/**
 * How one model of a provider added by hand thinks: what Timon detected, and
 * a correction when the detection is wrong.
 *
 * A gateway rarely says how its models think (B.AI lists ids and nothing
 * else), so the daemon detects it from the endpoint's own listing or from the
 * built-in models.dev catalogue. That catalogue speaks for the MODEL, not for
 * the endpoint: the user knows better, and what they set here wins over the
 * detection, on every save and every Test.
 */

import { useState, type ReactElement } from 'react';
import { Input } from '@/components/ui/input';
import type { ModelReasoning, ReasoningControl } from '@/lib/backends';
import { t } from '@/lib/i18n';
import { pickControl } from '@/lib/thinking-bar';
import { cn } from '@/lib/utils';
import { effectiveReasoning, parseLevels, thinkingChoiceOf, withThinkingChoice, type ModelDraft, type ThinkingChoice } from './form';
import { FIELD, HINT } from './type-scale';

function controlText(control: ReasoningControl): string {
  if (control.type === 'levels') return t('backendsSettings.thinking.kinds.levels', { values: control.values.join(', ') });
  if (control.type === 'toggle') return t('backendsSettings.thinking.kinds.toggle');
  return control.max !== undefined
    ? t('backendsSettings.thinking.kinds.budgetMax', { max: control.max })
    : t('backendsSettings.thinking.kinds.budget');
}

/** One line for what a resolution says, with where it comes from. */
export function reasoningText(reasoning: ModelReasoning | undefined): string {
  if (!reasoning) return t('backendsSettings.thinking.nothing');
  const what = !reasoning.thinks
    ? t('backendsSettings.thinking.kinds.none')
    : reasoning.controls.length
      ? reasoning.controls.map(controlText).join(' · ')
      : t('backendsSettings.thinking.kinds.nothingToSet');
  if (reasoning.source === 'catalog') return t('backendsSettings.thinking.fromCatalog', { what, entry: reasoning.catalogEntry ?? '' });
  if (reasoning.source === 'agent') return t('backendsSettings.thinking.fromProvider', { what });
  return what;
}

const CHOICES: ThinkingChoice[] = ['auto', 'levels', 'budget', 'toggle', 'none'];
/** The daemon refuses a larger bound (`reasoningControlSchema`). */
const MAX_BUDGET = 10_000_000;

export function ThinkingPanel({ model, saved, controls, className, onChange }: {
  model: ModelDraft;
  /** The daemon already knows this model: what it detected is in `model`. */
  saved: boolean;
  /** Kinds the provider's protocol can send. */
  controls: readonly ReasoningControl['type'][];
  className?: string;
  onChange: (next: ModelDraft) => void;
}): ReactElement {
  const choice = thinkingChoiceOf(model);
  // Typed text, kept as typed: re-deriving it from the parsed list would eat
  // the comma the user is about to follow with the next level.
  const [levelsText, setLevelsText] = useState(() => (model.supportedReasoningLevels ?? []).join(', '));
  const budgetMax = model.reasoningControl?.type === 'budget' ? model.reasoningControl.max : undefined;
  const offered = CHOICES.filter((option) => option === 'auto' || option === 'none' || controls.includes(option) || option === choice);
  const shown = pickControl(effectiveReasoning(model), controls);
  const detected = effectiveReasoning({ ...model, supportedReasoningLevels: undefined, reasoningControl: undefined });

  return (
    <div className={cn('space-y-2 rounded-md border border-border bg-muted/20 p-2', className)}>
      <p className={HINT}>
        {t('backendsSettings.thinking.detected', {
          what: detected || saved ? reasoningText(detected) : t('backendsSettings.thinking.pending'),
        })}
      </p>
      <div role="radiogroup" aria-label={t('backendsSettings.thinking.choice')} className="flex flex-wrap gap-0.5 rounded-md border border-border bg-background/60 p-0.5">
        {offered.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === choice}
            onClick={() => onChange(withThinkingChoice(model, option, option === 'levels' ? { levels: parseLevels(levelsText) } : {}))}
            className={cn(
              'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
              option === choice ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`backendsSettings.thinking.choices.${option}`)}
          </button>
        ))}
      </div>
      {choice === 'levels' ? (
        <div className="space-y-1">
          <Input
            aria-label={t('backendsSettings.thinking.levelsLabel')}
            value={levelsText}
            placeholder={t('backendsSettings.thinking.levelsPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            // code-font: effort level ids sent to the CLI
            className={cn(FIELD, 'font-mono')}
            onChange={(e) => {
              setLevelsText(e.target.value);
              onChange(withThinkingChoice(model, 'levels', { levels: parseLevels(e.target.value) }));
            }}
          />
          <p className={HINT}>{t('backendsSettings.thinking.levelsHint')}</p>
        </div>
      ) : null}
      {choice === 'budget' ? (
        <div className="space-y-1">
          <Input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            aria-label={t('backendsSettings.thinking.maxLabel')}
            value={budgetMax ?? ''}
            placeholder={t('backendsSettings.thinking.maxLabel')}
            className={FIELD}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const max = raw && /^\d+$/.test(raw) ? Math.min(Number(raw), MAX_BUDGET) : undefined;
              onChange(withThinkingChoice(model, 'budget', { max }));
            }}
          />
          <p className={HINT}>{t('backendsSettings.thinking.maxHint')}</p>
        </div>
      ) : null}
      <p className={HINT}>
        {t('backendsSettings.thinking.shown', { what: t(`backendsSettings.thinking.shownAs.${shown?.type ?? 'none'}`) })}
      </p>
    </div>
  );
}
