'use client';

/**
 * The provider cards in the onboarding (`mode: 'onboarding'`): one row per AI
 * CLI in a single card — its mark, its name, where it stands, and the one
 * gesture that moves it on (Connected, Sign in, Install). The same host and
 * the same data as the full cards (`provider-cli-cards.tsx`); only the
 * drawing is tighter, so the "Choose your LLM" step holds on a 1366×768
 * screen. What a gesture needs to say (the sign-in command, an installer's
 * console, a failure) opens under its row.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Check, ExternalLink, Loader2, LogIn, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/brand-mark';
import { CommandToRun } from '@/components/command-to-run';
import { providerCliState, type InstallJob, type ProviderCli } from '@/lib/provider-clis';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useProviderCliCards, type ProviderCliSignInOutcome } from './provider-cli-context';

/** Rows drawn while the daemon looks: the list's length is not known yet. */
const SEARCH_ROWS = 3;

export function ProviderCliRows(): ReactElement | null {
  const host = useProviderCliCards();
  // A sign-in happens in a terminal and a browser: coming back to this window is the moment to look again.
  const [awaiting, setAwaiting] = useState(false);
  const refresh = host?.refresh;
  useEffect(() => {
    if (!awaiting || !refresh) return;
    const again = (): void => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [awaiting, refresh]);

  if (!host) return null;
  if (host.unavailable) return <p className="text-center text-sm text-muted-foreground">{t('providerClis.unavailable')}</p>;
  return (
    <div className="flex w-full min-h-0 flex-col items-center gap-2">
      <div className="w-full min-h-0 overflow-y-auto rounded-2xl bg-card p-1.5 text-left shadow-elev-2" data-provider-rows>
        {host.backends
          ? host.backends.map((cli) => (
            <ProviderCliRow key={cli.name} cli={cli} job={host.jobs[cli.name] ?? null} onSignIn={() => setAwaiting(true)} />
          ))
          : Array.from({ length: SEARCH_ROWS }, (_, i) => <SearchRow key={i} />)}
      </div>
      {host.backends && (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-muted-foreground" disabled={host.busy || host.disabled} onClick={() => void host.refresh()}>
          <RefreshCw className={cn('size-3.5', host.busy && 'animate-spin')} aria-hidden />
          {t('providerClis.retry')}
        </Button>
      )}
    </div>
  );
}

function SearchRow(): ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-xl p-2.5" aria-hidden>
      <span className="size-8 shrink-0 animate-pulse rounded-[10px] bg-muted" />
      <span className="h-2.5 w-28 animate-pulse rounded-full bg-muted" />
      <span className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />{t('providerClis.rows.searching')}
      </span>
    </div>
  );
}

function ProviderCliRow({ cli, job, onSignIn }: { cli: ProviderCli; job: InstallJob | null; onSignIn: () => void }): ReactElement {
  const host = useProviderCliCards();
  const [outcome, setOutcome] = useState<ProviderCliSignInOutcome | null>(null);
  const state = providerCliState(cli);
  const running = job?.state === 'running';
  const failed = job?.state === 'failed' ? job : null;
  const canInstall = cli.installable && !cli.unsupportedVersion && state === 'missing';
  const blocked = !host || host.disabled || running;
  const manual = failed?.result?.command ?? cli.installCommand;

  const signIn = (): void => {
    if (!host) return;
    onSignIn();
    void host.signIn(cli.name).then(setOutcome);
  };

  let action: ReactElement | null = null;
  if (state === 'ready') {
    action = (
      <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-500/15 px-3 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
        <Check className="size-3.5" aria-hidden />{t('providerClis.rows.connected')}
      </span>
    );
  } else if (running) {
    action = (
      <span role="status" className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />{t('providerClis.installing')}
      </span>
    );
  } else if (state === 'signIn' || state === 'bundled') {
    action = (
      <Button type="button" size="sm" variant="secondary" className="gap-1.5" disabled={blocked} onClick={signIn}>
        <LogIn className="size-3.5" aria-hidden />{t('providerClis.signIn')}
      </Button>
    );
  } else if (canInstall) {
    action = (
      <Button type="button" size="sm" variant="secondary" disabled={blocked} onClick={() => void host?.install(cli.name)}>
        {t('providerClis.install')}
      </Button>
    );
  } else if (state === 'missing' && cli.installDocs) {
    action = (
      <a href={cli.installDocs} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-md bg-secondary px-3 text-xs font-medium text-secondary-foreground hover:bg-secondary/80">
        {t('providerClis.install')}<ExternalLink className="size-3" aria-hidden />
      </a>
    );
  }

  return (
    <section aria-label={cli.label} data-state={running ? 'installing' : state} className="rounded-xl p-2.5 transition-colors hover:bg-muted/50">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-muted">
          <BrandMark brand={cli.brand ?? ''} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{cli.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {running ? t('providerClis.installing') : t(`providerClis.rows.state.${state}`)}
            {cli.version && state !== 'missing' ? <span className="tabular-nums"> · {t('providerClis.version', { version: cli.version })}</span> : null}
          </p>
        </div>
        {action}
      </div>
      {cli.unsupportedVersion && (
        <p className="mt-1.5 pl-11 text-xs text-amber-700 dark:text-amber-300">{t('providerClis.unsupportedVersion', { name: cli.label, version: cli.version ?? '' })}</p>
      )}
      {running && job && job.lines.length > 0 && (
        // code-font: the installer's last console line
        <p className="mt-1.5 truncate pl-11 font-mono text-[11px] text-muted-foreground" aria-live="polite">{job.lines[job.lines.length - 1]}</p>
      )}
      {failed && (
        <div className="mt-1.5 space-y-1 pl-11">
          <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{failed.result?.reason ?? t('providerClis.failed')}</p>
          {manual && <CommandToRun command={manual} label={t('providerClis.manual')} />}
        </div>
      )}
      {outcome && (state === 'signIn' || state === 'bundled') && (
        <div className="mt-1.5 pl-11">
          <p role="status" className="text-xs text-muted-foreground">{t(`providerClis.rows.signInOutcome.${outcome}`)}</p>
          <CommandToRun command={cli.signInCommand} label={cli.signInThen ? t('providerClis.signInThen', { command: cli.signInThen }) : t('providerClis.rows.signInCommand')} />
        </div>
      )}
    </section>
  );
}
