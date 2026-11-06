'use client';

/**
 * Automation (mockup `agentAutomationView`): five questions — missions, tools,
 * triggers, autonomy, notifications. The answered ones stay above the current
 * one, each a button that reopens it.
 */
import type { ReactElement, ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MISSIONS } from '@/components/mascot/agent-look';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  AUTONOMY, INTERVIEW_QUESTIONS, INTERVIEW_TOOLS, NOTIFY, nextQuestion, toggled,
  type AgentDraft, type InterviewTool, type InterviewTrigger,
} from '../agent-draft';
import { Chip, type UpdateDraft } from './parts';

/** The tiles' marks: a letter on the tool's colour, drawn here rather than a logo we do not ship. */
const TOOL_GLYPH: Readonly<Record<InterviewTool, readonly [string, string]>> = {
  gmail: ['M', '#ea4335'], gcal: ['31', '#4285f4'], gdrive: ['D', '#0f9d58'], slack: ['#', '#4a154b'], notion: ['N', '#2b2b2b'],
  telegram: ['➤', '#2aa1da'], github: ['G', '#24292f'], browser: ['◎', '#6b6b6b'], files: ['▤', '#8a6d3b'], webhook: ['⚡', '#7a5cff'],
};

export const triggerLabel = (trigger: InterviewTrigger, at: string): string => t(`onboarding.agent.interview.trigger.${trigger}`, { at });

/** The answer a past question shows. */
export function interviewAnswer(question: number, draft: AgentDraft): string {
  if (question === 1) return [...draft.missions.map((m) => t(`onboarding.agent.mission.${m}`)), draft.other.trim()].filter(Boolean).join(', ');
  if (question === 2) return draft.tools.map((tool) => t(`onboarding.agent.interview.tool.${tool}`)).join(', ');
  if (question === 3) return draft.triggers.map((tr) => triggerLabel(tr, draft.at)).join(', ');
  if (question === 4) return t(`onboarding.agent.interview.autonomy.${draft.autonomy}.title`);
  return draft.notify.map((n) => t(`onboarding.agent.interview.notify.${n}`)).join(', ');
}

const QUESTIONS = Array.from({ length: INTERVIEW_QUESTIONS }, (_, i) => i + 1);

function Box({ on }: { on: boolean }): ReactElement {
  return (
    <span className={cn('grid size-[17px] shrink-0 place-items-center rounded-[5px]', on ? 'bg-foreground text-background' : 'text-transparent ring-[1.5px] ring-inset ring-border')}>
      <Check className="size-3" aria-hidden />
    </span>
  );
}

function TriggerRow({ on, onToggle, disabled, children, aside }: {
  on: boolean; onToggle?: () => void; disabled?: boolean; children: ReactNode; aside?: ReactNode;
}): ReactElement {
  return (
    <div
      role="checkbox"
      aria-checked={on}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => { if (!disabled && !(e.target as HTMLElement).closest('input')) onToggle?.(); }}
      onKeyDown={(e) => { if (!disabled && (e.key === ' ' || e.key === 'Enter') && !(e.target as HTMLElement).closest('input')) { e.preventDefault(); onToggle?.(); } }}
      className={cn('flex items-center gap-2.5 rounded-xl bg-muted px-3 py-2.5 text-[13.5px]', disabled ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-accent')}
    >
      <Box on={on} />
      <span className="flex-1">{children}</span>
      {aside}
    </div>
  );
}

function QuestionBody({ draft, update }: { draft: AgentDraft; update: UpdateDraft }): ReactElement | null {
  const q = draft.question;
  if (q === 1) {
    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          {MISSIONS.map((m) => (
            <Chip key={m} data-mission={m} on={draft.missions.includes(m)} onClick={() => update((d) => ({ ...d, missions: toggled(d.missions, m) }))}>
              {t(`onboarding.agent.mission.${m}`)}
            </Chip>
          ))}
        </div>
        <input
          value={draft.other}
          onChange={(e) => { const other = e.target.value; update((d) => ({ ...d, other })); }}
          placeholder={t('onboarding.agent.interview.other')}
          maxLength={200}
          className="mt-2 h-[42px] w-full rounded-xl bg-muted px-3 text-[13.5px] outline-none ring-1 ring-inset ring-border focus:ring-foreground/55"
        />
      </>
    );
  }
  if (q === 2) {
    return (
      <>
        <div className="grid grid-cols-2 gap-1.5">
          {INTERVIEW_TOOLS.map((tool) => {
            const on = draft.tools.includes(tool);
            const [glyph, bg] = TOOL_GLYPH[tool];
            return (
              <button
                key={tool}
                type="button"
                data-tool={tool}
                aria-pressed={on}
                onClick={() => update((d) => ({ ...d, tools: toggled(d.tools, tool) }))}
                className={cn('flex items-center gap-2.5 rounded-xl bg-muted px-2.5 py-2 text-left transition-[background-color,box-shadow] hover:bg-accent', on && 'ring-[1.5px] ring-inset ring-foreground/45')}
              >
                <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg text-xs font-extrabold text-white" style={{ background: bg }}>{glyph}</span>
                <span className="flex-1 text-[13px] font-semibold">{t(`onboarding.agent.interview.tool.${tool}`)}</span>
                <Box on={on} />
              </button>
            );
          })}
        </div>
        <p className="mx-0.5 mt-2 text-xs text-muted-foreground">{t('onboarding.agent.interview.toolsHint')}</p>
      </>
    );
  }
  if (q === 3) {
    const toggle = (tr: InterviewTrigger) => () => update((d) => ({ ...d, triggers: toggled(d.triggers, tr) }));
    return (
      <div className="flex flex-col gap-1.5">
        <TriggerRow on disabled aside={<span className="text-xs text-muted-foreground">{t('onboarding.agent.interview.always')}</span>}>
          {triggerLabel('chat', draft.at)}
        </TriggerRow>
        <TriggerRow
          on={draft.triggers.includes('daily')}
          onToggle={toggle('daily')}
          aside={(
            <input
              type="time"
              value={draft.at}
              aria-label={t('onboarding.agent.interview.dailyAt')}
              onChange={(e) => {
                const at = e.target.value;
                update((d) => ({ ...d, at, triggers: d.triggers.includes('daily') ? d.triggers : [...d.triggers, 'daily'] }));
              }}
              className="h-[34px] w-[110px] rounded-lg bg-background px-2.5 text-[13px] tabular-nums outline-none ring-1 ring-inset ring-border"
            />
          )}
        >
          {t('onboarding.agent.interview.dailyAt')}
        </TriggerRow>
        <TriggerRow on={draft.triggers.includes('mail')} onToggle={toggle('mail')} aside={<span className="text-xs text-muted-foreground">{t('onboarding.agent.interview.tool.gmail')}</span>}>
          {triggerLabel('mail', draft.at)}
        </TriggerRow>
        <TriggerRow on={draft.triggers.includes('hook')} onToggle={toggle('hook')} aside={<span className="text-xs text-muted-foreground">{t('onboarding.agent.interview.urlProvided')}</span>}>
          {triggerLabel('hook', draft.at)}
        </TriggerRow>
      </div>
    );
  }
  if (q === 4) {
    return (
      <div className="flex flex-col gap-1.5" role="radiogroup">
        {AUTONOMY.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={draft.autonomy === k}
            data-autonomy={k}
            onClick={() => update((d) => ({ ...d, autonomy: k }))}
            className={cn('flex flex-col items-start rounded-[14px] px-4 py-3 text-left transition-colors', draft.autonomy === k ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent')}
          >
            <span className="text-[14.5px] font-semibold">{t(`onboarding.agent.interview.autonomy.${k}.title`)}</span>
            <span className={cn('mt-0.5 text-[12.5px]', draft.autonomy === k ? 'text-background/75' : 'text-muted-foreground')}>{t(`onboarding.agent.interview.autonomy.${k}.description`)}</span>
          </button>
        ))}
      </div>
    );
  }
  if (q === 5) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {NOTIFY.map((n) => (
          <Chip key={n} data-notify={n} on={draft.notify.includes(n)} onClick={() => update((d) => ({ ...d, notify: toggled(d.notify, n) }))}>
            {t(`onboarding.agent.interview.notify.${n}`)}
          </Chip>
        ))}
      </div>
    );
  }
  return null;
}

export function InterviewView({ draft, update }: { draft: AgentDraft; update: UpdateDraft }): ReactElement {
  const q = draft.question;
  const done = q > INTERVIEW_QUESTIONS;
  return (
    <div className="flex flex-col gap-1.5" data-interview>
      {QUESTIONS.filter((k) => k < q).map((k) => (
        <button
          key={k}
          type="button"
          data-edit-question={k}
          onClick={() => update((d) => ({ ...d, question: k }))}
          className="flex items-center gap-3 rounded-[13px] bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">{k}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-muted-foreground">{t(`onboarding.agent.interview.q${k}`)}</span>
            <span className="truncate text-[13.5px] font-semibold">{interviewAnswer(k, draft) || '—'}</span>
          </span>
          <span className="text-xs text-muted-foreground">{t('onboarding.agent.interview.edit')}</span>
        </button>
      ))}
      {!done && (
        <div key={q} data-question={q} className="timon-onboarding-rise mt-2 rounded-[18px] bg-card p-4 ring-1 ring-border">
          <p className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold">
            <span className="text-xs font-semibold tabular-nums text-muted-foreground">
              {t('onboarding.agent.interview.count', { current: q, total: INTERVIEW_QUESTIONS })}
            </span>
            {t(`onboarding.agent.interview.q${q}`)}
          </p>
          <QuestionBody draft={draft} update={update} />
          <div className="mt-3.5 flex items-center justify-between">
            {q > 1
              ? <Button type="button" variant="ghost" onClick={() => update((d) => ({ ...d, question: d.question - 1 }))}>{t('onboarding.back')}</Button>
              : <span />}
            <Button type="button" variant="secondary" data-next-question onClick={() => update(nextQuestion)}>
              {q === INTERVIEW_QUESTIONS ? t('onboarding.agent.interview.finish') : t('onboarding.continue')}
              <ArrowRight className="ml-1.5 size-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
