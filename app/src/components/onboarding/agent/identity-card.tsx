'use client';

/**
 * The left of the agent step, the same in every view: the agent's mascot,
 * alive, "Random" and "Customise" under it, its name with a draw button,
 * its role and model, and what it will do. The mascot goes through the
 * `agent.mascot` slot (`AgentMascotHost`): a plugin that replaces the mascot
 * replaces it here too.
 */
import type { ReactElement, ReactNode } from 'react';
import { Dices, Paintbrush, Shuffle } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import type { AgentLook } from '@/components/mascot/agent-look';
import { furOf } from '@/components/mascot/mascot-geometry';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ModelOption } from '../agent-draft';

/** Long enough for a name, short enough for the card. */
export const AGENT_NAME_MAX = 24;

export type IdentityCardProps = {
  look: AgentLook;
  name: string;
  onName: (name: string) => void;
  onRollName: () => void;
  onRandomLook: () => void;
  onCustomise: () => void;
  styling: boolean;
  role: { label: string; empty?: boolean };
  model: ModelOption | null;
  summary: ReactNode;
  /** Bumped to make the mascot jump (a new look, a new name, the creation). */
  jump: number;
  disabled?: boolean;
};

export function IdentityCard(props: IdentityCardProps): ReactElement {
  const { look, name, role, model, jump, disabled } = props;
  return (
    <aside
      data-identity-card
      className="relative overflow-hidden rounded-[26px] bg-card px-5 pb-5 pt-[22px] text-center shadow-elev-3 ring-1 ring-border md:sticky md:top-2"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-60 opacity-50 transition-[background] duration-500"
        style={{ background: `radial-gradient(260px 200px at 50% 26%, ${furOf(look.color)}, transparent 70%)` }}
      />
      <div className="relative grid h-[130px] place-items-center">
        <span key={jump} className={cn('inline-grid', jump > 0 && 'rooks-mascot-jump')}>
          <AgentMascotHost look={look} size={124} live label={name.trim() || null} />
        </span>
      </div>
      <div className="relative mb-1 mt-1.5 flex justify-center gap-2">
        <button
          type="button"
          data-random-look
          disabled={disabled}
          onClick={props.onRandomLook}
          className="inline-flex h-[34px] items-center gap-[7px] rounded-full bg-foreground/10 pl-3 pr-3.5 text-[13px] font-semibold ring-1 ring-foreground/10 backdrop-blur transition-[background-color,transform] hover:-translate-y-px hover:bg-foreground/15 active:scale-95"
        >
          <Shuffle className="size-4" aria-hidden />
          {t('onboarding.agent.random')}
        </button>
        <button
          type="button"
          data-customise
          aria-expanded={props.styling}
          aria-controls="agent-look-styler"
          disabled={disabled}
          onClick={props.onCustomise}
          className="inline-flex h-[34px] items-center gap-[7px] rounded-full bg-foreground pl-3 pr-3.5 text-[13px] font-semibold text-background transition-[background-color,transform] hover:-translate-y-px active:scale-95"
        >
          <Paintbrush className="size-4" aria-hidden />
          {t('onboarding.agent.customise')}
        </button>
      </div>
      <label className="relative mb-2 mt-3.5 block text-left">
        <span className="mb-1.5 ml-0.5 block text-[11.5px] font-semibold text-muted-foreground">{t('onboarding.agent.nameLabel')}</span>
        <span className="relative block">
          <input
            data-agent-name
            value={name}
            maxLength={AGENT_NAME_MAX}
            disabled={disabled}
            placeholder={t('onboarding.agent.namePlaceholder')}
            onChange={(e) => props.onName(e.target.value)}
            className="h-12 w-full rounded-[13px] bg-muted px-11 text-center text-xl font-bold tracking-[-0.01em] outline-none ring-1 ring-inset ring-border transition-shadow placeholder:font-semibold placeholder:text-muted-foreground hover:bg-accent focus:ring-[1.5px] focus:ring-foreground/55"
          />
          <button
            type="button"
            data-roll-name
            disabled={disabled}
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
