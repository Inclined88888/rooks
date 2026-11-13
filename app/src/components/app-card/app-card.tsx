'use client';

/**
 * An app card of the Apps catalogue, and the host that paints it. The host
 * (`AppCardHost`) puts one app in context and paints the `apps.card` slot's
 * occupant — the product's card while no plugin took the slot, or when the
 * module that registers it is off. The product's card (`ProductAppCard`) is
 * that default occupant: it takes no props and reads `useAppCard()`.
 */

import { useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { Check, ExternalLink, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { APP_CARD_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AppCardProvider, useAppCard, type AppCardApp, type AppCardStatus, type AppCardValue } from './app-card-context';

export function AppCardHost({ value }: { value: AppCardValue }): ReactElement {
  const claimed = useSlotEntries(APP_CARD_SLOT).length > 0;
  return (
    <AppCardProvider value={value}>
      {claimed ? <SlotSingle name={APP_CARD_SLOT} /> : <ProductAppCard />}
    </AppCardProvider>
  );
}

/** Black or white text, whichever reads on the brand colour (WCAG relative luminance). */
export function monogramInk(hex: string): '#000000' | '#FFFFFF' {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.4 ? '#000000' : '#FFFFFF';
}

/**
 * The brand tile of an app: the publisher's logo when the catalogue ships one,
 * its monogram otherwise. The logo is drawn from path data, never injected markup.
 */
export function AppIcon({ icon, size = 'md' }: { icon: AppCardApp['icon']; size?: 'xs' | 'md' | 'lg' }): ReactElement {
  const ink = monogramInk(icon.color);
  return (
    <span
      aria-hidden
      className={cn(
        // The ring keeps a white tile visible on a light card.
        'inline-flex shrink-0 items-center justify-center font-semibold tracking-tight ring-1 ring-inset ring-black/[0.06] dark:ring-white/10',
        size === 'lg' ? 'size-12 rounded-xl text-[17px]' : size === 'xs' ? 'size-4 rounded-[4px] text-[8px]' : 'size-10 rounded-[10px] text-[14px]',
      )}
      style={{ backgroundColor: icon.color, color: ink }}
    >
      {icon.logo ? (
        <svg viewBox={icon.logo.viewBox} className={size === 'lg' ? 'size-6' : size === 'xs' ? 'size-2.5' : 'size-5'} focusable="false">
          {icon.logo.paths.map((path, i) => <path key={i} d={path.d} fill={path.fill ?? ink} />)}
        </svg>
      ) : icon.monogram}
    </span>
  );
}

function StatusAction({ host, onOpen }: { host: AppCardValue; onOpen: () => void }): ReactElement {
  const { status } = host;
  if (status === 'connected') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 text-[12.5px] text-muted-foreground">
        <Check className="size-3.5 text-[hsl(var(--success))]" /> {t('apps.status.connected')}
      </span>
    );
  }
  if (status === 'blocked') {
    return <span className="px-2 text-[12.5px] text-muted-foreground">{t('apps.status.blocked')}</span>;
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      className="h-8 shrink-0 gap-1.5 px-3 font-normal"
      disabled={status === 'connecting'}
      onClick={(e) => {
        e.stopPropagation();
        // A key is typed in the details; an OAuth or open app connects at once.
        if (host.app.auth.type === 'key') onOpen();
        else void host.connect();
      }}
    >
      {status === 'connecting' ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
      {status === 'consent' ? t('apps.action.finishSignIn') : t('apps.action.connect')}
    </Button>
  );
}

/** The product's card: one row — logo, name, tagline, the one action its state allows; details in a dialog. */
export function ProductAppCard(): ReactElement | null {
  const host = useAppCard();
  const [open, setOpen] = useState(false);
  if (!host) return null;
  const { app } = host;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={t('apps.card.open', { name: app.name })}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AppIcon icon={app.icon} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{app.name}</div>
          <div className="truncate text-[12.5px] text-muted-foreground">{app.tagline}</div>
        </div>
        <StatusAction host={host} onOpen={() => setOpen(true)} />
      </div>
      <AppDetailsDialog host={host} open={open} onOpenChange={setOpen} />
    </>
  );
}

function StatusPill({ status }: { status: AppCardStatus }): ReactElement {
  const on = status === 'connected';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11.5px] text-muted-foreground">
      <span aria-hidden className={cn('size-1.5 rounded-full', on ? 'bg-[hsl(var(--success))]' : 'bg-muted-foreground/60')} />
      {t(`apps.details.status.${status}`)}
    </span>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function ExternalLinkText({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
      {children} <ExternalLink className="size-3 text-muted-foreground" />
    </a>
  );
}

function AppDetailsDialog({ host, open, onOpenChange }: { host: AppCardValue; open: boolean; onOpenChange: (open: boolean) => void }): ReactElement {
  const { app, status } = host;
  const [key, setKey] = useState('');
  const busy = status === 'connecting';
  const canConnect = status !== 'connected' && status !== 'blocked';

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (app.auth.type === 'key') {
      if (!key.trim()) return;
      if (await host.connect(key.trim())) { setKey(''); onOpenChange(false); }
      return;
    }
    await host.connect();
  }

  const connectionLine = app.auth.type === 'key'
    ? app.auth.label
    : app.auth.type === 'oauth' ? t('apps.details.signInWith', { name: app.publisher }) : t('apps.details.noAccount');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-[720px] gap-0 overflow-y-auto p-0">
        <DialogHeader className="flex-row items-start gap-3.5 space-y-0 px-6 pb-4 pt-6 pr-12">
          <AppIcon icon={app.icon} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="text-[17px]">{app.name}</DialogTitle>
              <StatusPill status={status} />
            </div>
            <DialogDescription className="mt-0.5 text-[12.5px]">{app.tagline}</DialogDescription>
          </div>
          {(status === 'connected' || status === 'consent') && (
            <Button variant="secondary" size="sm" className="h-8 font-normal" disabled={busy} onClick={async () => { if (await host.disconnect()) onOpenChange(false); }}>
              {t('apps.action.disconnect')}
            </Button>
          )}
          {canConnect && app.auth.type !== 'key' && (
            <Button size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => void submit()}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {status === 'consent' ? t('apps.action.finishSignIn') : t('apps.action.connect')}
            </Button>
          )}
        </DialogHeader>

        <div className="flex flex-col gap-6 px-6 pb-6">
          <section
            aria-label={t('apps.details.examples')}
            className="flex flex-col gap-2 rounded-2xl bg-muted px-6 py-6 sm:px-14"
            style={{ backgroundImage: `radial-gradient(120% 140% at 0% 0%, ${app.icon.color}59, transparent 60%), radial-gradient(120% 140% at 100% 100%, ${app.icon.color}33, transparent 60%)` }}
          >
            {app.examples.map((example) => (
              <div key={example} className="flex items-start gap-2.5 rounded-xl bg-background/90 px-3.5 py-2.5 text-[13px] leading-relaxed shadow-sm">
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[11.5px] font-medium">
                  <AppIcon icon={app.icon} size="xs" /> {app.name}
                </span>
                <span>{example}</span>
              </div>
            ))}
          </section>

          <section>
            <h3 className="m-0 mb-2 text-[13px] font-medium text-muted-foreground">{t('apps.details.connection')}</h3>
            <div className="flex flex-col gap-3 rounded-xl bg-muted/50 px-4 py-3">
              <div className="flex items-center gap-3">
                <AppIcon icon={app.icon} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{app.publisher}</div>
                  <div className="text-[12px] text-muted-foreground">{connectionLine}</div>
                </div>
              </div>
              {app.auth.type === 'key' && canConnect && (
                <form onSubmit={submit} className="flex flex-col gap-1.5">
                  <div className="flex gap-2">
                    <Input
                      id={`app-key-${app.slug}`}
                      aria-label={app.auth.label}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      disabled={busy || host.vaultOff}
                      className="h-8"
                    />
                    <Button type="submit" size="sm" className="h-8 gap-1.5" disabled={busy || !key.trim() || host.vaultOff}>
                      {busy && <Loader2 className="size-3.5 animate-spin" />}
                      {t('apps.action.connect')}
                    </Button>
                  </div>
                  <p className="m-0 text-[11.5px] text-muted-foreground">
                    {host.vaultOff ? t('apps.details.vaultOff') : t('apps.details.keyKept')}{' '}
                    <a href={app.auth.helpUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{t('apps.details.getKey')}</a>
                  </p>
                </form>
              )}
              {status === 'consent' && host.consentUrl && (
                <p className="m-0 text-[12px] text-muted-foreground">
                  {t('apps.details.consentPending')}{' '}
                  <a href={host.consentUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{t('apps.details.openConsent')}</a>
                </p>
              )}
              {status === 'connected' && <p className="m-0 text-[12px] text-muted-foreground">{t('apps.details.attachHint', { id: app.mcpId })}</p>}
              {status === 'blocked' && <p className="m-0 text-[12px] text-muted-foreground">{t('apps.details.blockedHint', { id: app.mcpId })}</p>}
            </div>
          </section>

          <section>
            <h3 className="m-0 mb-2 text-[13px] font-medium text-muted-foreground">{t('apps.details.info')}</h3>
            <div className="rounded-xl bg-muted/50 px-4 py-3">
              <p className="m-0 mb-3 text-[13px] leading-relaxed">{app.description}</p>
              <InfoRow label={t('apps.details.developer')}>{app.publisher}</InfoRow>
              <InfoRow label={t('apps.details.category')}>{t(`apps.category.${app.category}`)}</InfoRow>
              <InfoRow label={t('apps.details.website')}><ExternalLinkText href={app.links.website}>{new URL(app.links.website).host}</ExternalLinkText></InfoRow>
              <InfoRow label={t('apps.details.privacy')}><ExternalLinkText href={app.links.privacy}>{t('apps.details.read')}</ExternalLinkText></InfoRow>
              <InfoRow label={t('apps.details.terms')}><ExternalLinkText href={app.links.terms}>{t('apps.details.read')}</ExternalLinkText></InfoRow>
              <InfoRow label={t('apps.details.endpoint')}><span /* code-font: URL of the MCP endpoint */ className="font-mono text-[11.5px]">{app.url}</span></InfoRow>
              <p className="m-0 mt-2 text-[11.5px] text-muted-foreground">{t('apps.details.remoteOnly')}</p>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
