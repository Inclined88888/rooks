'use client';

/**
 * Left of the agent step: name + role + summary. Calm hairline card — no
 * mascot, no Random/Customise look controls (owner: flat premium onboarding).
 */
import type { ReactElement, ReactNode } from 'react';
import { Dices } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ModelOption } from '../agent-draft';

/** Long enough for a name, short enough for the card. */
export const AGENT_NAME_MAX = 24;

export type IdentityCardProps = {
  name: string;
  onName: (name: string) => void;
  onRollName: () => void;
  role: { label: string; empty?: boolean };
  model: ModelOption | null;
  summary: ReactNode;
  disabled?: boolean;
};

export function IdentityCard(props: IdentityCardProps): ReactElement {
  const { name, role, model, disabled } = props;
  const initial = (name.trim() || '?').slice(0, 1).toUpperCase();
  return (
    <aside
      data-identity-card
      className="relative min-w-0 rounded-lg border border-border bg-card px-5 pb-5 pt-5 text-center lg:sticky lg:top-2"
    >
      <div
        aria-hidden
        className="mx-auto mb-3 grid size-14 place-items-center rounded-full border border-border bg-background text-lg font-semibold tracking-tight text-foreground"
        data-identity-mark
      >
        {initial}
      </div>
      <label className="relative mb-2 block text-left">
        <span className="mb-1.5 ml-0.5 block text-[11.5px] font-semibold text-muted-foreground">{t('onboarding.agent.nameLabel')}</span>
        <span className="relative block">
          <input
            data-agent-name
            value={name}
            maxLength={AGENT_NAME_MAX}
            disabled={disabled}
            placeholder={t('onboarding.agent.namePlaceholder')}
            onChange={(e) => props.onName(e.target.value)}
            className="h-11 w-full rounded-lg border border-border bg-background px-10 text-center text-lg font-semibold tracking-[-0.01em] outline-none transition-shadow placeholder:font-medium placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            data-roll-name
            disabled={disabled}
            onClick={props.onRollName}
            title={t('onboarding.agent.nameRoll')}
            aria-label={t('onboarding.agent.nameRoll')}
            className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Dices className="size-4" aria-hidden />
          </button>
        </span>
      </label>
      <div className="relative mb-3 flex flex-wrap items-center justify-center gap-2 text-[12.5px] text-muted-foreground" data-role-row>
        <span
          data-role-pill
          className={cn(
            'inline-flex h-[26px] max-w-full items-center truncate rounded-full px-[11px] text-[12.5px]',
            role.empty ? 'font-medium text-muted-foreground ring-1 ring-inset ring-border' : 'bg-muted font-semibold text-foreground',
          )}
        >
          {role.label}
        </span>
        {model && (
          <span className="inline-flex items-center gap-1.5" data-model={`${model.backend}/${model.model}`}>
            <BrandMark brand={model.brand} icon={model.icon} slug={model.model} className="size-[15px]" />
            {model.label}
          </span>
        )}
      </div>
      <div className="relative flex min-h-[46px] flex-col gap-1.5 rounded-lg border border-border bg-background px-3.5 py-3 text-left" data-identity-summary>
        {props.summary}
      </div>
    </aside>
  );
}
