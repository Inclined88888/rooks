'use client';

/**
 * The small pieces the agent step's views share: a toggle chip, the "It
 * will" list, a summary row. Surfaces are told apart by contrast and spacing
 * (AGENTS.md rule 16): no line between two blocks.
 */
import type { ReactElement, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { MascotMission } from '@/components/mascot/agent-look';
import type { AgentDraft } from '../agent-draft';

export type UpdateDraft = (change: (draft: AgentDraft) => AgentDraft) => void;

export function Chip({ on, onClick, children, className, ...rest }: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, string>): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-[background-color,color,transform] active:scale-95',
        on ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** "It will": chatting with you, then one line per mission. No badges. */
export function Capabilities({ missions }: { missions: readonly MascotMission[] }): ReactElement {
  const lines = ['base', ...missions];
  return (
    <div className="flex flex-col gap-1.5" data-capabilities>
      <h5 className="mb-0.5 text-[11.5px] font-semibold text-muted-foreground">{t('onboarding.agent.will')}</h5>
      {lines.map((line, i) => (
        <div key={line} data-cap={line} className="rooks-onboarding-rise flex items-center gap-2.5 text-[13.5px]" style={{ animationDelay: `${i * 0.06}s` }}>
          <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-500">
            <Check className="size-3" aria-hidden />
          </span>
          {t(`onboarding.agent.cap.${line}`)}
        </div>
      ))}
    </div>
  );
}

export function SummaryRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex justify-between gap-3 text-[12.5px] text-muted-foreground">
      <span>{label}</span>
      <b className="text-right font-semibold text-foreground [overflow-wrap:anywhere]">{children}</b>
    </div>
  );
}

/** A section title inside a view. */
export function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return <h3 className="mb-2 text-[13.5px] font-semibold">{children}</h3>;
}
