'use client';

import { t } from '@/lib/i18n';
import type { ThinkingBar } from '@/lib/thinking-bar';
import { cn } from '@/lib/utils';

/** The positions of the slider: the model's own default, then each value the
 *  model takes, lowest first. */
export function thinkingSteps(values: readonly string[]): string[] {
  return ['', ...values];
}

/** An effort the model still supports, else back to its default (''). Called
 *  when the model changes: a value of the previous model may not exist here. */
export function keepEffort(effort: string, values: readonly string[]): string {
  return values.includes(effort) ? effort : '';
}

/**
 * How hard the model thinks before answering, in the shape the model takes:
 * a slider over its levels or over budget steps, or an off / on switch.
 * Nothing is drawn for a model with nothing to set: a slider with a single
 * position would only look broken.
 */
export function ThinkingSlider({ bar, value, onChange }: {
  bar: ThinkingBar | null;
  value: string;
  onChange: (effort: string) => void;
}) {
  if (!bar) {
    return <p className="text-[11.5px] text-muted-foreground">{t('thinking.unsupported')}</p>;
  }
  const steps = thinkingSteps(bar.stops.map((stop) => stop.value));
  const index = Math.max(0, steps.indexOf(value));
  const label = (step: string) => (step === '' ? t('thinking.default') : bar.stops.find((stop) => stop.value === step)?.label ?? step);
  if (bar.type === 'toggle') {
    return (
      <div role="radiogroup" aria-label={t('thinking.label')} className="inline-flex w-fit gap-0.5 rounded-lg border border-border bg-muted/20 p-0.5">
        {steps.map((step, i) => (
          <button
            key={step || 'default'}
            type="button"
            role="radio"
            aria-checked={i === index}
            onClick={() => onChange(step)}
            className={cn(
              'rounded-md px-3 py-1 text-[11px] transition-colors',
              i === index ? 'bg-secondary font-semibold text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label(step)}
          </button>
        ))}
      </div>
    );
  }
  const title = (step: string) => (bar.type === 'budget' && step ? t('thinking.budgetTokens', { tokens: step }) : undefined);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 px-3.5 py-3">
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        step={1}
        value={index}
        aria-label={t('thinking.label')}
        aria-valuetext={label(steps[index]!)}
        title={title(steps[index]!)}
        onChange={(e) => onChange(steps[Number(e.target.value)] ?? '')}
        className="w-full accent-primary"
      />
      <div className="flex justify-between text-[10.5px] text-muted-foreground">
        {steps.map((step, i) => (
          <span key={step || 'default'} title={title(step)} className={i === index ? 'font-semibold text-primary' : undefined}>{label(step)}</span>
        ))}
      </div>
    </div>
  );
}
