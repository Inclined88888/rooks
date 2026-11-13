'use client';

/** Beginner (mockup `agentBeginnerView`): six ready-made profiles, each with its mascot. */
import type { ReactElement } from 'react';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { TEMPLATE_IDS, templateLook, type TemplateId } from '../agent-draft';

export function TemplatesView({ picked, onPick }: { picked: TemplateId | null; onPick: (id: TemplateId) => void }): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label={t('onboarding.agent.templates.title')}>
      {TEMPLATE_IDS.map((id) => (
        <button
          key={id}
          type="button"
          data-template={id}
          aria-pressed={picked === id}
          onClick={() => onPick(id)}
          className={cn(
            'flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition-[background-color,transform,box-shadow] hover:-translate-y-0.5',
            id === 'blank' ? 'bg-transparent ring-1 ring-inset ring-border' : 'bg-card hover:bg-muted',
            picked === id && 'bg-muted ring-[1.5px] ring-inset ring-foreground/55',
          )}
        >
          <span className="shrink-0"><AgentMascotHost look={templateLook(id)} size={42} shadow={false} fit /></span>
          <span className="min-w-0">
            <span className="block text-[14.5px] font-semibold">{t(`onboarding.agent.templates.${id}.title`)}</span>
            <span className="block text-[12.5px] leading-snug text-muted-foreground">{t(`onboarding.agent.templates.${id}.description`)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
