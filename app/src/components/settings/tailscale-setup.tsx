'use client';

/**
 * "Install Tailscale", "Sign in to Tailscale" and, on Linux, "Let Rooks
 * manage Tailscale": the steps the Devices card walks through before it can
 * make this machine reachable. The daemon does the work
 * (`orchestrator/src/tailscale-setup.ts`); this card starts a step, polls the
 * job, and hands back to the caller once Tailscale runs.
 *
 * In the desktop app, a daemon with no desktop (Windows service, macOS
 * LaunchDaemon) verifies the package and stops at `handoff`: this card then
 * asks the app to open it in the user's session (`desktop/src/tailscale-installer.ts`).
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyToClipboard } from '@/lib/clipboard';
import { desktopBridge } from '@/lib/desktop';
import { t } from '@/lib/i18n';
import {
  handoffKey, installerOutcomeOf, readTailscaleSetup, setupView, shouldPoll, startTailscaleStep,
  type SetupJob, type SetupStep, type TailscaleSetupStatus,
} from '@/lib/tailscale-setup';

/** The desktop app's Tailscale helpers, `null` in a browser or an older app. */
function tailscaleBridge() {
  const bridge = desktopBridge()?.tailscale;
  return bridge && typeof bridge.openInstaller === 'function' && typeof bridge.openApp === 'function' ? bridge : null;
}

const POLL_MS = 2000;
/** An installer or a sign-in nobody finishes: the card stops asking, a click resumes. */
const POLL_LIMIT_MS = 15 * 60_000;

/** `undefined` while first asked, `null` when the daemon gave no usable answer. */
function useTailscaleSetup(): {
  status: TailscaleSetupStatus | null | undefined;
  start: (step: SetupStep) => Promise<void>;
  refresh: () => Promise<void>;
  /** Desktop app only: open the verified installer again (the app refuses a second one already open). */
  reopenInstaller: (() => void) | null;
} {
  const [status, setStatus] = useState<TailscaleSetupStatus | null | undefined>(undefined);
  const since = useRef(Date.now());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const next = await readTailscaleSetup();
    if (live.current) setStatus(next);
  }, []);
  const start = useCallback(async (step: SetupStep) => {
    since.current = Date.now();
    const bridge = tailscaleBridge();
    // macOS: the app owns the node, and a LaunchDaemon cannot open it in this session.
    if (step === 'connect' && bridge && status?.platform === 'darwin') await bridge.openApp().catch(() => undefined);
    const next = await startTailscaleStep(step, { desktop: bridge !== null });
    if (live.current) setStatus(next);
  }, [status?.platform]);

  // Once per job: the app opens the verified installer, then the job is read again.
  const handed = useRef<string | null>(null);
  const handoff = handoffKey(status);
  const openInstaller = useCallback((key: string) => {
    const bridge = tailscaleBridge();
    if (!bridge) return;
    // A failure the app reported shows on the job itself; one it could not report, here.
    void bridge.openInstaller()
      .then((outcome) => installerOutcomeOf(outcome))
      .catch(() => 'failed' as const)
      .then(async (outcome) => {
        const next = await readTailscaleSetup();
        if (live.current) setStatus(next);
        if (outcome === 'failed' && handoffKey(next) === key) toast.error(t('devicesSettings.tailscale.failures.installer_failed'));
      });
  }, []);
  useEffect(() => {
    if (!handoff || handed.current === handoff) return;
    handed.current = handoff;
    openInstaller(handoff);
  }, [handoff, openInstaller]);
  const reopenInstaller = handoff && tailscaleBridge() ? () => openInstaller(handoff) : null;

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!shouldPoll(status ?? null) || Date.now() - since.current > POLL_LIMIT_MS) return;
    const timer = setTimeout(() => { void refresh(); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [status, refresh]);

  return { status, start, refresh, reopenInstaller };
}

/** Why a step failed, and the command that does it by hand on this machine. */
function StepFailure({ job, platform }: { job: SetupJob; platform: string | null }): ReactElement {
  const copy = async () => {
    if (job.command && await copyToClipboard(job.command)) toast.success(t('devicesSettings.reachable.commandCopied'));
  };
  return (
    <div role="alert" className="space-y-1.5 rounded-md bg-destructive/10 px-3 py-2">
      <p className="max-w-[65ch] text-[12px] leading-snug">{t(`devicesSettings.tailscale.failures.${job.failure ?? 'failed'}`)}</p>
      {job.detail && <p className="break-all text-[11px] text-muted-foreground">{job.detail}</p>}
      {job.command && (
        <>
          <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t(platform === 'win32' ? 'devicesSettings.reachable.runHintWindows' : 'devicesSettings.reachable.runHint')}
          </p>
          {/* code-font: a command line to copy */}
          <code className="block select-all break-all rounded-md bg-background px-2 py-1.5 font-mono text-[12px]">{job.command}</code>
          <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => void copy()}>
            {t('devicesSettings.reachable.copyCommand')}
          </Button>
        </>
      )}
    </div>
  );
}

function Progress({ label }: { label: string }): ReactElement {
  return (
    <p role="status" className="flex max-w-[65ch] items-center gap-2 text-[12px] leading-snug text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      <span>{label}</span>
    </p>
  );
}

function busyLabel(step: SetupStep, phase: string, platform: string | null): string {
  if (step === 'connect') return t('devicesSettings.tailscale.waitingLogin');
  if (step === 'operator') return t('devicesSettings.tailscale.operatorWaiting');
  if (phase === 'downloading') return t('devicesSettings.tailscale.downloading');
  if (phase === 'verifying') return t('devicesSettings.tailscale.verifying');
  if (phase === 'handoff') return t(platform === 'win32' ? 'devicesSettings.tailscale.handoffWindows' : 'devicesSettings.tailscale.handoffMac');
  return t(platform === 'win32'
    ? 'devicesSettings.tailscale.installingWindows'
    : platform === 'darwin' ? 'devicesSettings.tailscale.installingMac' : 'devicesSettings.tailscale.installingLinux');
}

/**
 * Shown when publishing failed because Tailscale is missing or not signed in.
 * Once it runs: `onReady` once (`autoContinue`), or a button to try again.
 */
export function TailscaleSetupFlow({ autoContinue, onReady }: { autoContinue: boolean; onReady: () => void }): ReactElement | null {
  const { status, start, refresh, reopenInstaller } = useTailscaleSetup();
  const [starting, setStarting] = useState(false);
  const opened = useRef<string | null>(null);
  const view = status ? setupView(status) : null;

  const authUrl = view?.kind === 'busy' ? view.authUrl : null;
  useEffect(() => {
    // Once per URL: the person may close the tab, the link below stays.
    if (!authUrl || opened.current === authUrl) return;
    opened.current = authUrl;
    window.open(authUrl, '_blank', 'noopener,noreferrer');
  }, [authUrl]);

  const ready = view?.kind === 'ready';
  useEffect(() => {
    if (ready && autoContinue) onReady();
  }, [ready, autoContinue, onReady]);

  const run = async (step: SetupStep) => {
    setStarting(true);
    await start(step);
    setStarting(false);
  };

  if (status === undefined) return <Progress label={t('devicesSettings.tailscale.checking')} />;
  if (status === null || !view) {
    return <p role="alert" className="text-[12px] text-destructive">{t('devicesSettings.reachable.errors.generic')}</p>;
  }

  if (view.kind === 'busy') {
    return (
      <div className="space-y-1.5">
        <Progress label={busyLabel(view.step, view.phase, status.platform)} />
        {view.authUrl && (
          <a href={view.authUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] text-foreground underline underline-offset-4">
            {t('devicesSettings.tailscale.openSignIn')}
          </a>
        )}
        {view.phase === 'handoff' && reopenInstaller && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" onClick={reopenInstaller}>
            {t('devicesSettings.tailscale.reopenInstaller')}
          </Button>
        )}
      </div>
    );
  }

  if (view.kind === 'ready') {
    if (autoContinue) return <Progress label={t('devicesSettings.reachable.busy')} />;
    return (
      <div className="space-y-1.5">
        <p className="text-[12px] text-muted-foreground">{t('devicesSettings.tailscale.ready')}</p>
        <Button type="button" size="sm" className="h-7 text-[12px]" onClick={onReady}>{t('devicesSettings.reachable.retry')}</Button>
      </div>
    );
  }

  if (view.kind === 'unreadable') {
    return (
      <div role="alert" className="space-y-1.5 rounded-md bg-destructive/10 px-3 py-2">
        <p className="max-w-[65ch] text-[12px] leading-snug">{t('devicesSettings.reachable.errors.unreadable')}</p>
        {view.error && <p className="break-all text-[11px] text-muted-foreground">{view.error}</p>}
        <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => void refresh()}>
          {t('devicesSettings.reachable.retry')}
        </Button>
      </div>
    );
  }

  const install = view.step === 'install';
  return (
    <div className="space-y-2">
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
        {t(install ? 'devicesSettings.tailscale.installLead' : 'devicesSettings.tailscale.connectLead')}
      </p>
      <Button type="button" size="sm" className="h-7 text-[12px]" disabled={starting} onClick={() => void run(view.step)}>
        {t(install ? 'devicesSettings.tailscale.install' : 'devicesSettings.tailscale.connect')}
      </Button>
      {view.failure && <StepFailure job={view.failure} platform={status.platform} />}
      {view.failure?.failure === 'permission' && status.platform === 'linux' && <TailscaleOperatorStep onDone={() => void run('connect')} />}
    </div>
  );
}

/**
 * Linux: Tailscale refused this account. One click asks for the password
 * through the desktop's own dialog (pkexec) and makes it the operator.
 */
export function TailscaleOperatorStep({ onDone }: { onDone: () => void }): ReactElement {
  const { status, start } = useTailscaleSetup();
  const [starting, setStarting] = useState(false);
  const [asked, setAsked] = useState(false);
  const job = status?.job?.kind === 'operator' ? status.job : null;
  const done = asked && job?.phase === 'done';
  useEffect(() => {
    if (done) onDone();
  }, [done, onDone]);

  const run = async () => {
    setStarting(true);
    setAsked(true);
    await start('operator');
    setStarting(false);
  };

  if (asked && job && job.phase !== 'done' && job.phase !== 'failed') return <Progress label={t('devicesSettings.tailscale.operatorWaiting')} />;
  return (
    <div className="space-y-2">
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('devicesSettings.tailscale.operatorLead')}</p>
      <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={starting} onClick={() => void run()}>
        {t('devicesSettings.tailscale.operator')}
      </Button>
      {asked && job?.phase === 'failed' && <StepFailure job={job} platform={status?.platform ?? null} />}
    </div>
  );
}
