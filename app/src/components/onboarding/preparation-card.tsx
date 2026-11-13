'use client';

/**
 * "Preparing Rooks", the card in the bottom-right corner of the onboarding
 * (docs/ONBOARDING-PREPARATION.md). A companion of the shell
 * (`ONBOARDING_COMPANIONS`): it starts the preparation once the welcome is
 * passed, follows the reader through the account, the AI and the profile, and
 * steps aside on the agent and the chat, whose guard takes over. A stand-in
 * step that opens another screen starts nothing (`preparationStarts`).
 *
 * Each line is a fact the daemon answered, never a timer. A refusal shows
 * here with what to do — the exact command when the daemon knows one, "Try
 * again", and the repair screen — and blocks nothing but the steps that need
 * the service.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { AlertCircle, Check, Loader2, Minus } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CommandToRun } from '@/components/command-to-run';
import { SETUP_PATH } from '@/lib/first-run-gate';
import {
  ACCOUNT_POLL_MS, pollsForAccount, preparationHeadline, preparationProgress, preparationStarts, preparationVisible,
  type PreparationItem, type PreparationItemState,
} from '@/lib/setup-plan';
import type { OnboardingStepId } from './onboarding-flow';
import { preparation, usePreparation, type PreparationView } from './preparation';

/** The repair screen: the former first-run wizard, still reachable on its own. */
export const REPAIR_HREF = SETUP_PATH;

/** How long "Rooks is ready" stays unfolded before the card folds to its title. */
const FOLD_AFTER_MS = 1400;

function ItemIcon({ state }: { state: PreparationItemState }): ReactElement {
  if (state === 'done') {
    return (
      <span className="grid h-[13px] w-[13px] flex-none place-items-center rounded-full bg-emerald-500 text-emerald-950">
        <Check className="h-2 w-2" strokeWidth={4} aria-hidden />
      </span>
    );
  }
  if (state === 'running') return <Loader2 className="h-[13px] w-[13px] flex-none animate-spin" aria-hidden />;
  if (state === 'failed') return <AlertCircle className="h-[13px] w-[13px] flex-none text-destructive" aria-hidden />;
  if (state === 'skipped') return <Minus className="h-[13px] w-[13px] flex-none text-muted-foreground" aria-hidden />;
  return <span className="h-[13px] w-[13px] flex-none rounded-full ring-[1.5px] ring-inset ring-border" aria-hidden />;
}

function itemLabel(item: PreparationItem, view: PreparationView): string {
  if (item.id === 'service' && view.phase === 'portable') return t('onboarding.preparation.items.servicePortable');
  if (item.id === 'service' && view.phase === 'account') return t('onboarding.preparation.items.serviceAccount');
  if (item.id === 'browser' && item.state === 'skipped') return t('onboarding.preparation.items.browserAbsent');
  return t(`onboarding.preparation.items.${item.id}`);
}

/** The progress ring of the mockup: a conic fill, hollowed by a radial mask. */
function Ring({ percent }: { percent: number }): ReactElement {
  const hole = 'radial-gradient(circle 5px, transparent 98%, #000 100%)';
  return (
    <span
      aria-hidden
      className="h-4 w-4 flex-none rounded-full"
      style={{
        background: `conic-gradient(hsl(var(--foreground)) ${percent}%, hsl(var(--muted)) 0)`,
        maskImage: hole,
        WebkitMaskImage: hole,
      }}
    />
  );
}

/** Why the service failed and what to do: shared by the card and the guard. */
export function PreparationFailureHelp({ view, compact = false }: { view: PreparationView; compact?: boolean }): ReactElement | null {
  // The service's refusal first; otherwise the machine could not be read at all.
  const failure = view.shownFailure
    ?? (view.doctorRead === 'failed' ? { text: t('onboarding.preparation.doctorFailed'), command: null } : null);
  if (!failure) return null;
  return (
    <div className={cn('space-y-2 text-xs', compact && 'max-h-48 overflow-auto')}>
      {failure.text && <p className="whitespace-pre-wrap break-words text-muted-foreground">{failure.text}</p>}
      {failure.command && <CommandToRun command={failure.command} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={view.installing} onClick={() => void preparation().retry()}>
          {view.installing ? t('onboarding.preparation.retrying') : t('onboarding.preparation.retry')}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={REPAIR_HREF}>{t('onboarding.preparation.repair')}</a>
        </Button>
      </div>
    </div>
  );
}

export function PreparationCard({ step, stays }: { step: OnboardingStepId; stays: boolean }): ReactElement | null {
  const view = usePreparation();
  const [folded, setFolded] = useState(false);
  const headline = preparationHeadline(view.items);

  // Never on a stand-in that opens another screen: the page unloads under the install.
  useEffect(() => {
    if (preparationStarts(step, stays)) void preparation().start();
  }, [step, stays]);
  // A step change after the account step may be the session the daemon was waiting for.
  useEffect(() => {
    if (preparationStarts(step, stays)) void preparation().nudge();
  }, [step, stays]);

  // The daemon waits for an account: asked again on a slow beat until it answers, skipped while the tab is hidden.
  const waitsForAccount = pollsForAccount(view.phase, step, stays);
  useEffect(() => {
    if (!waitsForAccount) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void preparation().nudge();
    }, ACCOUNT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [waitsForAccount]);

  useEffect(() => {
    if (headline !== 'ready') { setFolded(false); return; }
    const timer = window.setTimeout(() => setFolded(true), FOLD_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [headline]);

  const shown = preparationVisible(step, view.started, stays);
  const title = headline === 'ready'
    ? t('onboarding.preparation.ready')
    : headline === 'failed' ? t('onboarding.preparation.needsYou') : t('onboarding.preparation.title');

  return (
    <aside
      role="status"
      aria-live="polite"
      aria-hidden={!shown}
      data-preparation={headline}
      className={cn(
        'fixed bottom-[18px] right-[18px] z-40 rounded-[15px] bg-card text-card-foreground shadow-elev-3 ring-1 ring-border',
        'transition-all duration-500 ease-out motion-reduce:transition-none',
        folded ? 'w-[184px] px-3 py-[9px]' : 'w-[270px] px-3.5 py-3',
        headline === 'failed' && !folded && 'w-[320px]',
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-5 opacity-0',
      )}
    >
      <div className="flex items-center gap-[9px] text-[13px] font-semibold">
        {headline === 'ready' ? <ItemIcon state="done" />
          : headline === 'failed' ? <ItemIcon state="failed" />
            : <Ring percent={preparationProgress(view.items)} />}
        <span>{title}</span>
      </div>
      {!folded && (
        <ul className="mt-2.5 flex flex-col gap-[7px]">
          {view.items.map((item) => (
            <li
              key={item.id}
              data-item={item.id}
              data-state={item.state}
              className={cn(
                'flex items-center gap-[9px] text-[12.5px] transition-colors duration-300',
                item.state === 'running' && 'text-foreground',
                item.state === 'failed' && 'text-foreground',
                (item.state === 'done' || item.state === 'skipped' || item.state === 'idle') && 'text-muted-foreground',
              )}
            >
              <ItemIcon state={item.state} />
              {itemLabel(item, view)}
            </li>
          ))}
        </ul>
      )}
      {!folded && headline === 'failed' && (
        <div className="mt-3">
          <PreparationFailureHelp view={view} compact />
        </div>
      )}
    </aside>
  );
}
