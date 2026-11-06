'use client';

/**
 * The provider cards: each AI CLI of the product's providers as the DAEMON
 * sees it — not installed, installed but not signed in, ready — with its
 * vendor's official installer run on a click, the console of that installer
 * while it runs, the sign-in line built on the path the daemon resolved, and
 * "Update available" when the vendor has published a newer version.
 *
 * One component for three screens (the onboarding's "Choose your LLM" step,
 * drawn as rows, its "cannot start" screen, Settings › AI models ›
 * Providers), and a slot
 * (`providers.cli`) so a plugin can replace it on all three at once:
 * `ProviderCliCards` is the host that owns the data, `ProductProviderCliCards`
 * the product's occupant, which reads the host's context like any replacement.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowUpCircle, ExternalLink, Loader2, LogIn, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/brand-mark';
import { CommandToRun } from '@/components/command-to-run';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { PROVIDER_CLI_SLOT } from '@/lib/plugin-host/slots';
import {
  checkProviderClis, fetchProviderCliInstall, fetchProviderClis, providerCliState, startProviderCliInstall,
  type InstallJob, type ProviderCli, type ProviderCliList,
} from '@/lib/provider-clis';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import { openTerminalWindow } from '@/lib/terminal-web';
import { cn } from '@/lib/utils';
import {
  ProviderCliCardsProvider, useProviderCliCards, type ProviderCliCardsMode, type ProviderCliCardsValue, type ProviderCliSignInOutcome,
} from './provider-cli-context';
import { ProviderCliRows } from './provider-cli-rows';

/** How often a running install is read: often enough for a console to feel live. */
const POLL_MS = 1000;

type HostProps = {
  mode: ProviderCliCardsMode;
  disabled?: boolean;
  /** Every list the daemon answers, for the surface around (the onboarding's "Continue"); `null` when it refused or could not be reached. */
  onBackends?: (backends: ProviderCli[] | null) => void;
};

/**
 * The host: fetches the cards, follows the install jobs, and paints the slot's
 * occupant — the product's cards while no plugin took the slot, or on a page
 * the bundled halves do not reach.
 */
export function ProviderCliCards({ mode, disabled = false, onBackends }: HostProps): ReactElement {
  const [list, setList] = useState<ProviderCliList | null>(null);
  const [jobs, setJobs] = useState<Record<string, InstallJob>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const reported = useRef(onBackends);
  reported.current = onBackends;

  const apply = useCallback((next: ProviderCliList) => {
    setList(next);
    setUnavailable(false);
    setJobs((prev) => ({ ...prev, ...next.jobs }));
    reported.current?.(next.backends);
  }, []);

  const load = useCallback(async (read: () => Promise<ProviderCliList>) => {
    try {
      apply(await read());
    } catch {
      // Refused (not a superadmin) or unreachable: the surface keeps its own way forward.
      setUnavailable(true);
      reported.current?.(null);
    }
  }, [apply]);

  useEffect(() => { void load(fetchProviderClis); }, [load]);

  const running = useMemo(() => Object.values(jobs).filter((job) => job.state === 'running').map((job) => job.name), [jobs]);
  const runningKey = running.join(',');

  // A running installer is read every second; when it ends, the cards are read again.
  useEffect(() => {
    if (!runningKey) return;
    let stopped = false;
    const timer = setInterval(() => {
      void Promise.all(runningKey.split(',').map(async (name) => {
        try {
          const job = await fetchProviderCliInstall(name);
          if (stopped) return;
          setJobs((prev) => ({ ...prev, [name]: job }));
          if (job.state !== 'running') await load(fetchProviderClis);
        } catch { /* the next tick asks again */ }
      }));
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [runningKey, load]);

  const install = useCallback(async (name: string) => {
    try {
      const job = await startProviderCliInstall(name);
      setJobs((prev) => ({ ...prev, [name]: job }));
    } catch {
      setJobs((prev) => ({
        ...prev,
        [name]: {
          name, command: '', state: 'failed', startedAt: Date.now(), finishedAt: Date.now(), lines: [], dropped: 0,
          result: { ok: false, command: null, reason: t('providerClis.startFailed') },
        },
      }));
    }
  }, []);

  // The terminal the product already opens for "Paste into a terminal": the line is typed, Enter
  // stays the person's. A view without one (the onboarding has no island workspace) gets a copy.
  const backends = list?.backends;
  const signIn = useCallback(async (name: string): Promise<ProviderCliSignInOutcome> => {
    const command = backends?.find((cli) => cli.name === name)?.signInCommand;
    if (!command) return 'failed';
    if (openTerminalWindow({ insert: command })) return 'terminal';
    return (await copyToClipboard(command)) ? 'copied' : 'failed';
  }, [backends]);

  const withBusy = useCallback(async (read: () => Promise<ProviderCliList>) => {
    setBusy(true);
    try { await load(read); } finally { setBusy(false); }
  }, [load]);

  const value: ProviderCliCardsValue = {
    mode,
    backends: list?.backends ?? null,
    unavailable,
    jobs,
    updateCheck: list?.updateCheck ?? false,
    busy,
    disabled,
    install,
    refresh: () => withBusy(fetchProviderClis),
    checkUpdates: () => withBusy(checkProviderClis),
    signIn,
  };
  const claimed = useSlotEntries(PROVIDER_CLI_SLOT).length > 0;
  return (
    <ProviderCliCardsProvider value={value}>
      {claimed ? <SlotSingle name={PROVIDER_CLI_SLOT} /> : <ProductProviderCliCards />}
    </ProviderCliCardsProvider>
  );
}

/** The product's cards, as the default occupant of `providers.cli`. Takes no props: it reads the host. */
export function ProductProviderCliCards(): ReactElement | null {
  const host = useProviderCliCards();
  if (!host) return null;
  // The onboarding draws the same cards as rows: its step holds on one screen (docs/ONBOARDING-LLM.md).
  if (host.mode === 'onboarding') return <ProviderCliRows />;
  if (host.unavailable) return <p className="text-sm text-muted-foreground">{t('providerClis.unavailable')}</p>;
  if (!host.backends) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />{t('providerClis.loading')}
      </p>
    );
  }
  const anyRunning = Object.values(host.jobs).some((job) => job.state === 'running');
  return (
    <div className="space-y-3">
      <div className={cn('grid gap-3', host.mode !== 'recovery' && 'md:grid-cols-2')}>
        {host.backends.map((cli) => <ProviderCliCard key={cli.name} cli={cli} job={host.jobs[cli.name] ?? null} />)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={host.busy || host.disabled} onClick={() => void host.refresh()}>
          <RefreshCw className={cn('size-3.5', host.busy && 'animate-spin')} aria-hidden />
          {t('providerClis.retry')}
        </Button>
        {host.mode === 'settings' && host.updateCheck && (
          <Button type="button" size="sm" variant="ghost" disabled={host.busy || anyRunning} onClick={() => void host.checkUpdates()}>
            {t('providerClis.checkUpdates')}
          </Button>
        )}
        {host.mode === 'settings' && !host.updateCheck && (
          <p className="m-0 text-xs text-muted-foreground">{t('providerClis.updateCheckOff')}</p>
        )}
      </div>
    </div>
  );
}

function ProviderCliCard({ cli, job }: { cli: ProviderCli; job: InstallJob | null }): ReactElement {
  const host = useProviderCliCards();
  const state = providerCliState(cli);
  const running = job?.state === 'running';
  const failed = job?.state === 'failed' ? job : null;
  // An update re-runs the official installer: offered only where Timon can run it, never over a
  // generation the provider does not support (the installer would replace it).
  const canInstall = cli.installable && !cli.unsupportedVersion && (state === 'missing' || state === 'bundled');
  const canUpdate = cli.installable && !cli.unsupportedVersion && cli.updateAvailable && !canInstall;
  const blocked = !host || host.disabled || running;
  return (
    <section aria-label={cli.label} className="min-w-0 space-y-2 rounded-xl bg-card p-4 text-sm shadow-elev-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <BrandMark brand={cli.brand ?? ''} className="size-6" />
        <span className="font-medium">{cli.label}</span>
        <span className={state === 'ready'
          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300'
          : 'rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground'}>
          {t(`providerClis.state.${state}`)}
        </span>
        {cli.version && <span className="text-xs tabular-nums text-muted-foreground">{t('providerClis.version', { version: cli.version })}</span>}
        {canInstall && (
          <Button type="button" size="sm" className="ml-auto" disabled={blocked} onClick={() => void host?.install(cli.name)}>
            {running && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {running ? t('providerClis.installing') : t('providerClis.install')}
          </Button>
        )}
        {canUpdate && (
          <Button type="button" size="sm" variant="outline" className="ml-auto gap-1.5" disabled={blocked} onClick={() => void host?.install(cli.name)}>
            {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowUpCircle className="size-4" aria-hidden />}
            {running ? t('providerClis.updating') : t('providerClis.update')}
          </Button>
        )}
      </div>
      {cli.unsupportedVersion && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('providerClis.unsupportedVersion', { name: cli.label, version: cli.version ?? '' })}</p>
      )}
      {cli.updateAvailable && cli.latest && !cli.unsupportedVersion && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('providerClis.updateAvailable', { latest: cli.latest })}</p>
      )}
      {cli.path && <p className="break-all text-xs text-muted-foreground">{t('providerClis.path', { path: cli.path })}</p>}
      {job && (running || failed) && <InstallConsole job={job} />}
      {failed && (
        <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
          {failed.result?.reason ?? t('providerClis.failed')}
        </p>
      )}
      {(state === 'bundled' || state === 'signIn') && <SignIn cli={cli} bundled={state === 'bundled'} disabled={blocked} />}
      {!running && (canInstall || canUpdate) && (failed?.result?.command ?? cli.installCommand) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t('providerClis.manualSummary')}</summary>
          <CommandToRun command={(failed?.result?.command ?? cli.installCommand)!} label={t('providerClis.manual')} />
        </details>
      )}
      {!cli.installable && cli.installDocs && (state === 'missing' || cli.updateAvailable || cli.unsupportedVersion) && (
        <a href={cli.installDocs} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-4">
          {t('providerClis.docs', { name: cli.label })}<ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </section>
  );
}

/**
 * "Sign in": the host types the command in Timon's terminal or copies it, and the card says
 * which, with what comes next. The command stays shown below, for a terminal of one's own.
 */
function SignIn({ cli, bundled, disabled }: { cli: ProviderCli; bundled: boolean; disabled: boolean }): ReactElement {
  const host = useProviderCliCards();
  const [outcome, setOutcome] = useState<ProviderCliSignInOutcome | null>(null);
  return (
    <div className="space-y-1">
      <Button
        type="button" size="sm" variant="outline" className="gap-1.5" disabled={disabled || !host}
        onClick={() => { void host?.signIn(cli.name).then(setOutcome); }}
      >
        <LogIn className="size-4" aria-hidden />{t('providerClis.signIn')}
      </Button>
      {outcome && (
        <p role="status" className="text-xs text-muted-foreground">{signInLabel(`providerClis.signInOutcome.${outcome}`, cli.signInThen)}</p>
      )}
      <CommandToRun command={cli.signInCommand} label={signInLabel(bundled ? 'providerClis.bundledSignInHint' : 'providerClis.signInHint', cli.signInThen)} />
    </div>
  );
}

/** The installer's own lines while it runs, newest at the bottom and kept in view. */
function InstallConsole({ job }: { job: InstallJob }): ReactElement {
  const pane = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const node = pane.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [job.lines.length]);
  return (
    <div className="space-y-1" role="status" aria-live="polite">
      <p className="text-xs text-muted-foreground">
        {job.state === 'running' ? t('providerClis.running') : t('providerClis.ran')}{' '}
        {/* code-font: the command line being run */}
        <code className="break-all rounded bg-muted px-1 font-mono">{job.command}</code>
      </p>
      {job.lines.length > 0 && (
        <pre
          ref={pane}
          // code-font: the installer's console output
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed"
        >
          {job.dropped > 0 ? `${t('providerClis.dropped', { count: job.dropped })}\n` : ''}{job.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

/** The sign-in hint, plus what to type once the CLI runs when it needs it. */
function signInLabel(key: string, then: string | null): string {
  return then ? `${t(key)} ${t('providerClis.signInThen', { command: then })}` : t(key);
}
