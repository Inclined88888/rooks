'use client';

/**
 * The left of the agent step, the same in every view: a mark, its name with a
 * draw button, its role and model, and what it will do.
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
  /** The seat already has this name: a failed save must not rename it. */
  lockName?: boolean;
  disabled?: boolean;
};

export function IdentityCard(props: IdentityCardProps): ReactElement {
  const { name, role, model, disabled, lockName } = props;
  const nameHeld = disabled || lockName === true;
  return (
    <aside
      data-identity-card
      className="relative overflow-hidden rounded-[26px] bg-card px-5 pb-5 pt-[22px] text-center shadow-elev-3 ring-1 ring-border md:sticky md:top-2"
    >
      <div className="relative grid h-[72px] place-items-center text-lg font-semibold text-muted-foreground">
        {(name.trim() || 'R').slice(0, 1)}
      </div>
      <label className="relative mb-2 mt-3.5 block text-left">
        <span className="mb-1.5 ml-0.5 block text-[11.5px] font-semibold text-muted-foreground">{t('onboarding.agent.nameLabel')}</span>
        <span className="relative block">
          <input
            data-agent-name
            value={name}
            maxLength={AGENT_NAME_MAX}
            disabled={nameHeld}
            placeholder={t('onboarding.agent.namePlaceholder')}
            onChange={(e) => props.onName(e.target.value)}
            className="h-12 w-full rounded-[13px] bg-muted px-11 text-center text-xl font-bold tracking-[-0.01em] outline-none ring-1 ring-inset ring-border transition-shadow placeholder:font-semibold placeholder:text-muted-foreground hover:bg-accent focus:ring-[1.5px] focus:ring-foreground/55"
          />
          <button
            type="button"
            data-roll-name
            disabled={nameHeld}
            onClick={props.onRollName}
            title={t('onboarding.agent.nameRoll')}
            aria-label={t('onboarding.agent.nameRoll')}
            className="absolute right-1.5 top-1/2 grid size-[34px] -translate-y-1/2 place-items-center rounded-[9px] text-muted-foreground hover:bg-card hover:text-foreground"
          >
            <Dices className="size-[18px]" aria-hidden />
          </button>
        </span>
      </label>
      <div className="relative mb-3 flex flex-wrap items-center justify-center gap-2 text-[12.5px] text-muted-foreground" data-role-row>
        <span
          data-role-pill
          className={cn(
            'inline-flex h-[26px] items-center rounded-full px-[11px] text-[12.5px]',
            role.empty ? 'font-medium text-muted-foreground ring-1 ring-inset ring-border' : 'bg-foreground/10 font-semibold text-foreground',
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
      <div className="relative flex min-h-[46px] flex-col gap-1.5 rounded-[15px] bg-background px-3.5 py-3 text-left" data-identity-summary>
        {props.summary}
      </div>
    </aside>
  );
}
