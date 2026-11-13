'use client';

/**
 * The AI tools step (mockup screen `ai`, docs/ONBOARDING-LLM.md). The header
 * stays put — a row of mascots, the title, the promise — and only the block
 * under it changes, in place: the two choices, then the provider cards of the
 * subscription the person already pays for, or the local models. "Back"
 * first brings the two choices back on this same screen.
 *
 * The terms sit under the two choices. No usage-statistics box: sharing is on
 * by default and turned off in Settings › Privacy.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ArrowRight, Check, ChevronRight, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/brand-mark';
import { ProviderCliCards } from '@/components/provider-cli/provider-cli-cards';
import { fetchProviderClis, type ProviderCli } from '@/lib/provider-clis';
import { t } from '@/lib/i18n';
import { formatList } from '@/lib/intl';
import { settingsPath } from '@/lib/settings-path';
import {
  LEGAL_LINKS, llmBack, OLLAMA_DOWNLOAD_URL, OLLAMA_NAME, planStatus, splitAtSlots, subscriptionProviders,
  type LlmView, type ProviderAnswer,
} from '../llm-choice';
import { useOnboarding, useOnboardingBack } from '../onboarding-context';
import { ViewSwap } from '../view-swap';


export function LlmStep(): ReactElement {
  const { next } = useOnboarding();
  const [view, setView] = useState<LlmView>('choose');
  // Read once for the names on the "subscription" choice; the local block never waits for it.
  const [known, setKnown] = useState<ProviderAnswer>(undefined);
  useEffect(() => {
    let alive = true;
    fetchProviderClis()
      .then((list) => { if (alive) setKnown(list.backends); })
      .catch(() => { if (alive) setKnown(null); });
    return () => { alive = false; };
  }, []);
  useOnboardingBack(() => {
    const to = llmBack(view);
    if (!to) return false;
    setView(to);
    return true;
  });

  return (
    <section className="flex max-h-full min-h-0 w-[min(560px,100%)] flex-col items-center text-center" data-llm-step>
      <h1 className="mt-3 shrink-0 text-[28px] font-semibold leading-tight tracking-tight">
        {t('onboarding.llm.title')}
      </h1>
      <p className="mb-5 mt-3 max-w-[470px] shrink-0 text-[15px] leading-normal text-muted-foreground">{t('onboarding.llm.subtitle')}</p>
      <ViewSwap
        view={view}
        className="flex min-h-0 w-full flex-col items-center px-4 pb-5"
        render={(shown) => (shown === 'plan'
          ? <PlanBlock onContinue={next} />
          : shown === 'local'
            ? <LocalBlock onContinue={next} />
            : <ChooseBlock onPick={setView} known={known} />)}
      />
    </section>
  );
}

function ChooseBlock({ onPick, known }: { onPick: (view: LlmView) => void; known: ProviderAnswer }): ReactElement {
  const legal = splitAtSlots((vars) => t('onboarding.llm.legal', vars), ['terms', 'privacy']);
  const providers = known ? subscriptionProviders(known) : { names: [], brands: [] };
  return (
    <>
      <div className="w-full max-w-[460px] space-y-0.5 rounded-2xl bg-card p-1.5 text-left shadow-elev-2">
        <ChoiceRow
          title={t('onboarding.llm.plan.title')}
          detail={providers.names.length > 0 ? formatList(providers.names, 'or') : t('onboarding.llm.plan.detailAny')}
          onClick={() => onPick('plan')}
          marks={providers.brands.map((brand) => (
            <span key={brand} className="flex size-5 items-center justify-center rounded-md bg-muted">
              <BrandMark brand={brand} className="size-3.5" />
            </span>
          ))}
          name="plan"
        />
        <ChoiceRow
          title={t('onboarding.llm.local.title')}
          detail={t('onboarding.llm.local.detail')}
          onClick={() => onPick('local')}
          name="local"
        />
      </div>
      <p className="mt-4 max-w-[420px] text-xs leading-relaxed text-muted-foreground" data-legal>
        {legal.map((part, i) => (part.kind === 'text'
          ? <span key={i}>{part.text}</span>
          : (
            <a
              key={i}
              href={part.name === 'terms' ? LEGAL_LINKS.terms : LEGAL_LINKS.privacy}
              target="_blank"
              rel="noreferrer noopener"
              className="text-foreground underline underline-offset-2 hover:text-primary"
            >
              {t(part.name === 'terms' ? 'onboarding.llm.terms' : 'onboarding.llm.privacy')}
            </a>
          )))}
      </p>
    </>
  );
}

function ChoiceRow({ title, detail, onClick, marks, name }: {
  title: string; detail: string; onClick: () => void; marks?: ReactElement[]; name: string;
}): ReactElement {
  return (
    <button
      type="button"
      data-choice={name}
      onClick={onClick}
      className="group flex w-full items-center gap-3.5 rounded-xl p-3.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{detail}</span>
      </span>
      {marks && <span className="flex shrink-0 gap-1.5">{marks}</span>}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
    </button>
  );
}

function PlanBlock({ onContinue }: { onContinue: () => void }): ReactElement {
  const [answer, setAnswer] = useState<ProviderAnswer>(undefined);
  const onBackends = useCallback((backends: ProviderCli[] | null) => setAnswer(backends), []);
  const status = planStatus(answer);
  return (
    <>
      <p className="mb-2.5 max-w-[460px] text-[13px] text-muted-foreground">{t('onboarding.llm.plan.hint')}</p>
      <div className="flex min-h-0 w-full max-w-[500px] flex-col">
        <ProviderCliCards mode="onboarding" onBackends={onBackends} />
      </div>
      <p
        role="status"
        data-plan-status={status.line?.kind ?? 'none-yet'}
        className={status.line?.kind === 'ready'
          ? 'mt-2 flex h-[22px] items-center justify-center gap-1.5 text-[12.5px] text-emerald-700 dark:text-emerald-300'
          : 'mt-2 flex h-[22px] items-center justify-center gap-1.5 text-[12.5px] text-muted-foreground'}
      >
        {status.line?.kind === 'ready' && (
          <>
            <Check className="size-3.5" aria-hidden />
            {t('onboarding.llm.plan.ready', { names: formatList(status.line.names, 'and') })}
          </>
        )}
        {status.line?.kind === 'none' && t('onboarding.llm.plan.none')}
      </p>
      <Button type="button" className="mt-2 shrink-0 gap-2" disabled={!status.canContinue} onClick={onContinue} data-continue>
        {t('onboarding.continue')}<ArrowRight className="size-4" aria-hidden />
      </Button>
      {status.anyway && (
        <button
          type="button"
          data-anyway
          className="mt-1.5 shrink-0 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={onContinue}
        >
          {t('onboarding.llm.plan.anyway')}
        </button>
      )}
    </>
  );
}

function LocalBlock({ onContinue }: { onContinue: () => void }): ReactElement {
  return (
    <>
      <p className="mb-2.5 max-w-[460px] text-[13px] text-muted-foreground">{t('onboarding.llm.local.hint')}</p>
      <div className="w-full max-w-[460px] rounded-2xl bg-card p-1.5 text-left shadow-elev-2" data-ollama>
        <div className="flex items-center gap-3 rounded-xl p-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-muted">
            <BrandMark brand="ollama" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{OLLAMA_NAME}</p>
            <p className="text-xs text-muted-foreground">{t('onboarding.llm.local.ollama')}</p>
          </div>
          <a
            href={OLLAMA_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-secondary px-3 text-xs font-medium text-secondary-foreground shadow-sm hover:bg-secondary/80"
          >
            {t('providerClis.install')}<ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      </div>
      <p className="mt-3 max-w-[460px] text-xs leading-relaxed text-muted-foreground">
        {t('onboarding.llm.local.connect', { settingsPath: settingsPath('models', 'backends') })}
      </p>
      <Button type="button" className="mt-5 shrink-0 gap-2" onClick={onContinue} data-continue>
        {t('onboarding.continue')}<ArrowRight className="size-4" aria-hidden />
      </Button>
    </>
  );
}
