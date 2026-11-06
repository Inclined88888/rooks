'use client';

/**
 * The form an agent opens with its `question` tool. One tab per question,
 * walked with Next and closed with Send on the last one; every question with
 * options ends with a free-text field whose text joins THAT question's answer
 * (cf. `buildAskAnswers`). A question is answered by a ticked option or by its
 * text: Next and Send wait until it is.
 */
import { useId, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  askFormComplete,
  askQuestionAnswered,
  cardText,
  isFreeTextQuestion,
  optionActor,
  type AskUserActor,
  type AskUserQuestion,
} from '@/lib/ask-user-answers';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type AskFormState = 'pending' | 'allowed' | 'denied' | 'expired' | 'pasted';

type Picks = Record<string, string | string[]>;

export function ActorBadge({ actor }: { actor: AskUserActor }) {
  return (
    <span
      data-actor={actor}
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10.5px] font-medium',
        actor === 'agent'
          ? 'bg-primary/15 text-primary dark:bg-primary/20'
          : 'bg-foreground/10 text-foreground dark:bg-foreground/15',
      )}
    >
      {t(actor === 'agent' ? 'chatPage.askActorAgent' : 'chatPage.askActorUser')}
    </span>
  );
}

export function AskUserForm({
  questions,
  picks,
  setPicks,
  custom,
  setCustom,
  state,
  busy,
  onSubmit,
  onCancel,
  preamble = true,
}: {
  questions: AskUserQuestion[];
  picks: Picks;
  setPicks: (fn: (prev: Picks) => Picks) => void;
  custom: Record<string, string>;
  setCustom: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  state: AskFormState;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  /** "The agent has a question:" above the form. */
  preamble?: boolean;
}) {
  const pending = state === 'pending';
  const [tab, setTab] = useState(0);
  // One radio group per form: the same conversation shown twice (the page and
  // an island) would otherwise share its groups, each form unchecking the other.
  const formId = useId();
  const current = Math.min(tab, questions.length - 1);
  const q = questions[current];
  if (!q) return null;
  const isLast = current === questions.length - 1;
  const answered = (i: number) => askQuestionAnswered(questions[i]!, picks, custom);
  const canSubmit = askFormComplete(questions, picks, custom);
  const canAdvance = isLast ? canSubmit : answered(current);
  // A tab past an unanswered question is not reachable yet: Next is the way
  // forward, the tabs are the way back. A decided card reads freely.
  const reachable = (i: number) => !pending || questions.slice(0, i).every((_, j) => answered(j));
  const advance = () => {
    if (busy || !pending || !canAdvance) return;
    if (isLast) onSubmit();
    else setTab(current + 1);
  };
  const toggle = (label: string) =>
    setPicks((prev) => {
      const next = { ...prev };
      if (q.multiSelect) {
        const arr = Array.isArray(prev[q.question]) ? [...(prev[q.question] as string[])] : [];
        const i = arr.indexOf(label);
        if (i >= 0) arr.splice(i, 1);
        else arr.push(label);
        next[q.question] = arr;
      } else {
        // A second click on the ticked option unticks it: the free text alone
        // is a valid answer, and a radio cannot otherwise go back to nothing.
        next[q.question] = prev[q.question] === label ? '' : label;
      }
      return next;
    });
  const setText = (value: string) => setCustom((prev) => ({ ...prev, [q.question]: value }));
  const selected = picks[q.question];

  return (
    <div className="flex flex-col gap-3" data-ask-form>
      {preamble && (
        <div className="text-[12.5px] text-muted-foreground">
          {questions.length === 1 ? t('chatPage.agentHasOneQuestion') : t('chatPage.agentHasQuestions')}
        </div>
      )}
      {questions.length > 1 ? (
        <div role="tablist" className="flex flex-wrap gap-1">
          {questions.map((item, i) => (
            <button
              key={item.question}
              type="button"
              role="tab"
              aria-selected={i === current}
              disabled={!reachable(i)}
              onClick={() => setTab(i)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
                i === current
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-foreground/[0.06] text-foreground/80 hover:bg-foreground/[0.10] hover:text-foreground dark:bg-foreground/[0.10] dark:hover:bg-foreground/[0.17]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {pending && answered(i) && <Check className="h-3 w-3" aria-hidden />}
              {(item.header && cardText(item.header, item.headerKey)) || t('chatPage.askTab', { n: i + 1 })}
            </button>
          ))}
        </div>
      ) : (
        q.header && (
          <span className="inline-flex w-fit rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground/80">
            {cardText(q.header, q.headerKey)}
          </span>
        )
      )}
      <div role={questions.length > 1 ? 'tabpanel' : undefined} className="flex flex-col gap-1.5">
        {/* Line breaks kept and the height bounded: an agent may put a whole plan up for approval here. */}
        <div className="max-h-[50vh] overflow-y-auto whitespace-pre-line text-[13.5px] font-medium leading-snug">{q.question}</div>
        {isFreeTextQuestion(q) ? (
          <input
            type="text"
            autoFocus={pending}
            value={custom[q.question] ?? ''}
            disabled={!pending || busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                advance();
              }
            }}
            placeholder={q.placeholder || t('chatPage.yourAnswer')}
            aria-label={q.question}
            className="w-full rounded-md bg-foreground/[0.04] px-2.5 py-1.5 text-[13px] outline-none focus-visible:bg-foreground/[0.06] dark:bg-foreground/[0.07] dark:focus-visible:bg-foreground/[0.10] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-70"
          />
        ) : (
          <div className="flex flex-col gap-1">
            {(q.options ?? []).map((opt) => {
              const checked = q.multiSelect
                ? Array.isArray(selected) && selected.includes(opt.label)
                : selected === opt.label;
              const actor = optionActor(opt);
              return (
                <label
                  key={opt.label}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 transition-colors',
                    checked
                      ? 'bg-primary/[0.12] dark:bg-primary/20'
                      : 'bg-foreground/[0.04] hover:bg-foreground/[0.07] dark:bg-foreground/[0.07] dark:hover:bg-foreground/[0.12]',
                    !pending && 'cursor-default opacity-70',
                  )}
                >
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`${formId}:q:${q.question}`}
                    className="mt-1 accent-[hsl(var(--primary))]"
                    checked={checked}
                    disabled={!pending || busy}
                    // `onClick`, not `onChange`: a click on a ticked radio fires no change.
                    onClick={() => toggle(opt.label)}
                    onChange={() => {}}
                  />
                  <div className="min-w-0 leading-snug">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {actor && <ActorBadge actor={actor} />}
                      <span className="text-[13px] font-medium">{cardText(opt.label, opt.labelKey)}</span>
                    </div>
                    {opt.description && (
                      <div className="mt-0.5 text-[11.5px] text-muted-foreground">{cardText(opt.description, opt.descriptionKey)}</div>
                    )}
                  </div>
                </label>
              );
            })}
            <textarea
              value={custom[q.question] ?? ''}
              disabled={!pending || busy}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder={t('chatPage.askFreeTextPlaceholder')}
              aria-label={t('chatPage.askFreeTextLabel')}
              className="mt-1 w-full resize-y rounded-md bg-foreground/[0.04] px-2.5 py-1.5 text-[12.5px] leading-snug outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:bg-foreground/[0.06] dark:bg-foreground/[0.07] dark:focus-visible:bg-foreground/[0.10] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-70"
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        {pending ? (
          <>
            <Button size="sm" disabled={busy || !canAdvance} onClick={advance} className="h-7 gap-1.5" data-ask-action={isLast ? 'submit' : 'next'}>
              {isLast ? t('chatPage.askSubmit') : t('chatPage.askNext')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onCancel}
              className="h-7 gap-1.5 border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <span
            className={cn(
              'rounded px-2 py-0.5 text-[10.5px]',
              state === 'allowed'
                ? 'bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]'
                : state === 'expired'
                  ? 'bg-muted/50 text-muted-foreground'
                  : 'bg-destructive/10 text-destructive',
            )}
          >
            {t(state === 'allowed' ? 'chatPage.askAnswered' : state === 'expired' ? 'chatPage.askExpired' : 'chatPage.askCancelled')}
          </span>
        )}
      </div>
    </div>
  );
}
