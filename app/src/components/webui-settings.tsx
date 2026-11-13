'use client';

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Check, ChevronRight, Download, Globe, Monitor, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react';
import { CommandToRun } from '@/components/command-to-run';
import { t } from '@/lib/i18n';
import { remoteAccessCommands } from '@/lib/remote-access';
import { cn } from '@/lib/utils';
import { isSecureOrigin, tailnetUrl, type WebUiAccessReport } from '@/lib/webui-access';

/**
 * `WebUI` settings tab: where this interface answers, how to reach it from
 * another device through Tailscale, and whether that is safe.
 *
 * Laid out for someone who is not a network engineer: four status tiles
 * answer "does it work, is it safe" at a glance, a numbered setup walks the
 * remote access and ticks itself off, and the raw facts sit in a collapsed
 * details block. Read-only throughout — `app.listen`, `daemon.auth`,
 * `behindTlsProxy` and `trustedProxies` stay editable where they live, and a
 * writable copy here would give two screens the same value to disagree about.
 *
 * Every fact comes from the daemon: this component usually runs in the
 * `rooks-app` container, whose only interface is the Docker bridge and where
 * the `tailscale` binary does not exist.
 */
export function WebUiSettings(): ReactElement {
  const [report, setReport] = useState<WebUiAccessReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  // Read after mount: there is no `window` while the page renders on the
  // server, and the origin is the one fact no detection can get wrong.
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => { setHref(window.location.href); }, []);

  const load = useCallback(async () => {
    const response = await fetch('/api/ui/webui-access', { cache: 'no-store' });
    if (response.status === 401 || response.status === 403) { setState('forbidden'); return; }
    if (!response.ok) { setState('error'); return; }
    setReport(await response.json() as WebUiAccessReport);
    setState('ready');
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state === 'loading') return <section className="max-w-3xl" aria-busy="true" />;
  if (state === 'forbidden') return <Note>{t('webuiSettings.forbidden')}</Note>;
  if (state === 'error' || !report) return <Note>{t('webuiSettings.loadError')}</Note>;

  const origin = href ? new URL(href).origin : null;
  const secure = isSecureOrigin(href);
  const commands = remoteAccessCommands(report.app);
  const tailnet = tailnetUrl(report.tailscale.dnsName);
  const { tailscale, security } = report;
  const running = tailscale.installed && tailscale.state === 'Running';
  const published = tailscale.serve.length > 0;
  const remoteReady = running && published;
  const exposed = !security.daemon.loopbackOnly;
  const securityWarn = security.users === 0
    || security.daemon.auth === 'off'
    || (exposed && !security.daemon.authEnforced);

  return (
    <section className="max-w-3xl space-y-8">
      <div className="grid gap-3 sm:grid-cols-2">
        <StatusTile
          icon={Monitor}
          title={t('webuiSettings.statusScreen')}
          tone="neutral"
          value={origin ? <code /* code-font: URL */ className="font-mono text-[13px]">{origin}</code> : '—'}
          hint={report.app.servedByDaemon
            ? t('webuiSettings.servedByDaemon', { host: report.app.host, port: report.app.port })
            : t('webuiSettings.servedExternally')}
        />
        <StatusTile
          icon={Globe}
          title={t('webuiSettings.statusRemote')}
          tone={remoteReady ? 'ok' : running ? 'warn' : 'off'}
          value={remoteReady
            ? t('webuiSettings.remoteReady')
            : !tailscale.installed
              ? t('webuiSettings.remoteAbsent')
              : !running
                ? t('webuiSettings.remoteStopped')
                : t('webuiSettings.remoteNotPublished')}
          hint={remoteReady && tailnet ? (
            <a /* code-font: URL */ className="break-all font-mono underline" href={tailnet} rel="noreferrer noopener" target="_blank">
              {tailnet}
            </a>
          ) : t('webuiSettings.remoteSetupHint')}
        />
        <StatusTile
          icon={securityWarn ? ShieldAlert : ShieldCheck}
          title={t('webuiSettings.statusSecurity')}
          tone={securityWarn ? 'warn' : 'ok'}
          value={securityWarn ? t('webuiSettings.securityWarn') : t('webuiSettings.securityOk')}
          hint={
            <>
              {exposed ? t('webuiSettings.securityExposed') : t('webuiSettings.securityLocalOnly')}
              {' · '}
              {security.daemon.auth === 'off'
                ? t('webuiSettings.securityLoginOff')
                : security.daemon.authEnforced
                  ? t('webuiSettings.securityLoginRequired')
                  : t('webuiSettings.securityLoginNotEnforced')}
              {' · '}
              {security.users === 0
                ? t('webuiSettings.securityNoAccount')
                : t('webuiSettings.securityAccounts', { count: security.users })}
            </>
          }
        />
        <StatusTile
          icon={Download}
          title={t('webuiSettings.statusApp')}
          tone={secure ? 'ok' : 'off'}
          value={secure ? t('webuiSettings.appAvailable') : t('webuiSettings.appUnavailable')}
          hint={secure ? t('webuiSettings.appSecure') : t('webuiSettings.appInsecure')}
        />
      </div>

      <div>
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{t('webuiSettings.setupTitle')}</h3>
        <Note>{t('webuiSettings.setupIntro')}</Note>
        <ol className="mt-4 space-y-4">
          <Step n={1} done={tailscale.installed} title={t('webuiSettings.step1Title', { os: osLabel(tailscale.platform) })}>
            {!tailscale.installed && (
              <>
                <Note>{t('webuiSettings.step1NotPhone')}</Note>
                {tailscale.installCommand ? (
                  <>
                    <CommandToRun command={tailscale.installCommand} label={t('setupPage.remoteAccessCommandLabel')} />
                    {tailscale.platform === 'darwin' && <Note>{t('webuiSettings.step1MacHint')}</Note>}
                  </>
                ) : (
                  <Note>{t('webuiSettings.step1Unknown')}</Note>
                )}
                <a
                  className="mt-1 inline-block text-[12px] underline"
                  href="https://tailscale.com/download"
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {t('setupPage.remoteAccessDownload')}
                </a>
              </>
            )}
          </Step>
          <Step n={2} done={running} title={t('webuiSettings.step2Title')}>
            {!running && (
              <>
                {tailscale.installed && (
                  <Note>
                    {tailscale.error
                      ? t('webuiSettings.step2Unreadable', { detail: tailscale.error })
                      : t('webuiSettings.step2State', { state: tailscale.state ?? '—' })}
                  </Note>
                )}
                <CommandToRun command={commands.up} label={t('setupPage.remoteAccessCommandLabel')} />
              </>
            )}
          </Step>
          <Step n={3} done={published} title={t('webuiSettings.step3Title')}>
            {/* Kept even once published: re-pointing the handler is the same
                command, and the warning below says it replaces the old one. */}
            {commands.serve ? (
              <>
                <CommandToRun command={commands.serve} label={t('setupPage.remoteAccessCommandLabel')} />
                <Note>{t('setupPage.remoteAccessConsoleHint')}</Note>
              </>
            ) : (
              <Note>{t('setupPage.remoteAccessTargetUnknown')}</Note>
            )}
            {published && <Note>{t('webuiSettings.step3Replace')}</Note>}
          </Step>
          <Step n={4} done={false} title={t('webuiSettings.step4Title')}>
            {tailnet ? (
              <p className="text-[12px] leading-snug text-muted-foreground">
                {t('webuiSettings.step4Body')}{' '}
                <a /* code-font: URL */ className="break-all font-mono text-foreground underline" href={tailnet} rel="noreferrer noopener" target="_blank">
                  {tailnet}
                </a>
              </p>
            ) : (
              <Note>{t('webuiSettings.step4NoAddress')}</Note>
            )}
          </Step>
        </ol>
      </div>

      <details className="group rounded-xl border border-border/60">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
          {t('webuiSettings.detailsTitle')}
        </summary>
        <dl className="flex flex-col px-4 pb-1">
          <Fact label={t('webuiSettings.detailsAddresses')}>
            {report.addresses.length === 0 ? (
              <Note>{t('webuiSettings.addressesNone')}</Note>
            ) : (
              <ul className="space-y-0.5">
                {report.addresses.map((row) => (
                  <li key={`${row.iface}-${row.address}`} className="flex items-baseline gap-2">
                    <code /* code-font: IP address */ className="font-mono">{row.address}</code>
                    <span className="text-[11px] text-muted-foreground">{row.iface}</span>
                  </li>
                ))}
              </ul>
            )}
            <Note>{t('webuiSettings.addressesHint')}</Note>
          </Fact>
          {tailscale.dnsName && (
            <Fact label={t('webuiSettings.detailsTailnet')}>
              <code /* code-font: host name */ className="font-mono">{tailscale.dnsName}</code>
            </Fact>
          )}
          <Fact label={t('webuiSettings.detailsServe')}>
            {published ? (
              <ul className="space-y-0.5">
                {tailscale.serve.map((handler) => (
                  <li key={handler.host}>
                    <code /* code-font: host name */ className="font-mono">{handler.host}</code>
                    <span className="mx-1.5 text-muted-foreground">→</span>
                    <code /* code-font: proxy target */ className="font-mono">{handler.target}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <Note>{t('webuiSettings.serveNone')}</Note>
            )}
            <Note>{t('webuiSettings.serveHint')}</Note>
          </Fact>
          <Fact label={t('webuiSettings.detailsPublicUrl')}>
            <code /* code-font: URL */ className="font-mono">{report.app.publicUrl}</code>
          </Fact>
          <Fact label={t('webuiSettings.detailsListener')}>
            <code /* code-font: host and port */ className="font-mono">{security.daemon.host}:{security.daemon.port}</code>
            {security.daemon.loopbackOnly && (
              <span className="ml-2 text-[11px] text-muted-foreground">{t('webuiSettings.loopbackOnly')}</span>
            )}
          </Fact>
          <Fact label={t('webuiSettings.detailsAuth')}>
            <span>{security.daemon.auth}</span>
          </Fact>
          <Fact label={t('webuiSettings.detailsCookies')}>
            {security.behindTlsProxy ? t('webuiSettings.tlsProxyOn') : t('webuiSettings.tlsProxyOff')}
          </Fact>
          <Fact label={t('webuiSettings.detailsProxies')}>
            {security.trustedProxies.length === 0
              ? t('webuiSettings.trustedProxiesNone')
              : <code /* code-font: IP addresses */ className="font-mono">{security.trustedProxies.join(', ')}</code>}
          </Fact>
          <Fact label={t('webuiSettings.rulesTitle')}>
            <ol className="list-decimal space-y-1 pl-4">
              <li>{t('webuiSettings.rule1')}</li>
              <li>{t('webuiSettings.rule2')}</li>
              <li>{t('webuiSettings.rule3')}</li>
            </ol>
            <Note>{t('webuiSettings.editHint')}</Note>
          </Fact>
        </dl>
      </details>
    </section>
  );
}

type Tone = 'ok' | 'warn' | 'off' | 'neutral';

const TONE_DOT: Readonly<Record<Tone, string>> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  off: 'bg-muted-foreground/40',
  neutral: 'bg-sky-500',
};

function StatusTile({
  icon: Icon,
  title,
  tone,
  value,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  tone: Tone;
  value: ReactNode;
  hint: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-xl border border-border/60 bg-background/60 p-4">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Icon className="size-4" aria-hidden />
        {title}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
        <span className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone])} aria-hidden />
        <span className="min-w-0 break-words">{value}</span>
      </div>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold',
          done ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-foreground',
        )}
        aria-label={done ? t('webuiSettings.done') : undefined}
      >
        {done ? <Check className="size-3.5" aria-hidden /> : n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className={cn('text-[13px] font-medium leading-snug', done && 'text-muted-foreground')}>{title}</p>
        {children}
      </div>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="grid gap-1 py-3 text-[12.5px] sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 space-y-1">{children}</dd>
    </div>
  );
}

function Note({ children }: { children: ReactNode }): ReactElement {
  return <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{children}</p>;
}

/**
 * The host's OS, named the way its user names it. Read off `process.platform`
 * OF THE DAEMON: the phone reading this page is almost never the machine that
 * has to install tailscale, and naming the browser's OS here would send the
 * user to install it on the wrong device.
 */
function osLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}
