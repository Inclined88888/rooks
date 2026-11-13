'use client';

/** Beginner templates: calm hairline cards — no mascots, no lift/glow. */
import type { ReactElement } from 'react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { TEMPLATE_IDS, type TemplateId } from '../agent-draft';

export function TemplatesView({ picked, onPick }: { picked: TemplateId | null; onPick: (id: TemplateId) => void }): ReactElement {
  return (
    <div
      className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2"
      role="group"
      aria-label={t('onboarding.agent.templates.title')}
    >
      {TEMPLATE_IDS.map((id) => (
        <button
          key={id}
          type="button"
          data-template={id}
          aria-pressed={picked === id}
          onClick={() => onPick(id)}
          className={cn(
            'min-w-0 rounded-lg border border-border bg-background px-3.5 py-3 text-left transition-colors',
            'hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            picked === id && 'border-foreground/40 bg-muted',
          )}
        >
          <span className="block text-[14px] font-semibold leading-snug tracking-[-0.01em]">
            {t(`onboarding.agent.templates.${id}.title`)}
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">
            {t(`onboarding.agent.templates.${id}.description`)}
          </span>
        </button>
      ))}
    </div>
  );
}
